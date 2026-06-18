import type {
    AddressLike,
    BytesLike,
    Provider,
    TransactionRequest,
} from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolChainId,
} from '../addresses'
import { MAX_BPS } from '../constants'
import compareAddresses from '../helpers/compareAddresses'
import { Token } from '../helpers/Token'
import FundDataFetcher, {
    WEIGHT_DENOMINATOR,
    type GetPriceUsd1e18,
} from '../helpers/FundDataFetcher'
import ReceiptParser from '../helpers/ReceiptParser'
import { getRouteIn, getRouteOut, type RouterContext } from '../router'
import { encodeVaultExecute, type PrefixTx } from '../router/simulation'
import { quoteRebalanceSchema } from '../schemas/quoteRebalance'
import {
    FundController__factory,
    FundLedger__factory,
    TradeController__factory,
} from '../typechain'

export type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface QuoteRebalanceTargetWeight {
    /** Token address. */
    token: string
    /**
     * Target weight in WEIGHT_DENOMINATOR (100_000) basis. Accepts number for
     * convenience (matches the legacy procedure input shape) or bigint.
     */
    weight: number | bigint
}

export interface QuoteRebalanceParams {
    ledger: string
    targetWeights: QuoteRebalanceTargetWeight[]
    /**
     * Per-asset max slippage settings in e3 form (e.g. "500" = 0.5%,
     * "6000" = 6%). Used for the asset being sold in phase 1 and the asset
     * being bought in phase 2.
     */
    slippageSettings?: Record<string, string | number | bigint>
}

export interface QuoteRebalanceContext extends RouterContext {
    chainId: GuruProtocolChainId
    /** USD-1e18 price oracle injected into FundDataFetcher. */
    getPriceUsd1e18: GetPriceUsd1e18
}

export interface QuoteRebalanceTrade {
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    expectedAmountOut: bigint
}

export interface QuoteRebalanceLogTrade {
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    amountOut: bigint
}

export interface QuoteRebalanceLogs {
    trades: QuoteRebalanceLogTrade[]
}

export type SimulationLog = {
    address: string
    data: string
    topics: string[]
}

export type QuoteRebalanceEmptyReason = 'balanced' | 'dust' | null

export interface QuoteRebalanceResult {
    extCalls: ExternalCallStruct[]
    trades: QuoteRebalanceTrade[]
    cumulativeSlippageBps: bigint
    txData: TransactionRequest
    decodeLogs: (logs: SimulationLog[]) => QuoteRebalanceLogs | null
    emptyReason: QuoteRebalanceEmptyReason
}

// Tolerance for "close enough" weight (legacy: 500 in WEIGHT_DENOMINATOR = 0.5%)
const TOLERANCE = 500n
// Skip trades worth less than $5 (USDT 1e6 units)
const DUST_THRESHOLD = 5_000_000n
// fundData.totalValueLocked + amountToReceive (USDC) are 1e6-denominated; lift
// to 1e18 for cumulative-slippage math against asset.usd1e18Price.
const NORMALIZER = BigInt(1e12)

const absBigint = (v: bigint): bigint => (v < 0n ? -v : v)

export default async function quoteRebalance(
    params: QuoteRebalanceParams,
    ctx: QuoteRebalanceContext
): Promise<QuoteRebalanceResult> {
    const parsed = quoteRebalanceSchema.parse(params)

    const addresses = getGuruProtocolAddresses(ctx.chainId)
    const intermediary = addresses.tokens.USDC
    const provider: Provider = ctx.provider
    // const ledger = connectFundLedger(parsed.ledger, provider)
    const ledger = FundLedger__factory.connect(parsed.ledger, provider)

    const fetcher = new FundDataFetcher({
        chainId: ctx.chainId,
        provider,
        getPriceUsd1e18: ctx.getPriceUsd1e18,
    })

    const [fundData, vault, manager, controllerAddress] = await Promise.all([
        fetcher.fetchFundData(ledger),
        ledger.vault(),
        ledger.manager(),
        ledger.controller(),
    ])

    const targetWeightMap = new Map<string, bigint>()
    let totalTargetWeight = 0n
    for (const tw of parsed.targetWeights) {
        const w = tw.weight
        targetWeightMap.set(tw.token.toLowerCase(), w)
        totalTargetWeight += w
    }
    if (totalTargetWeight !== WEIGHT_DENOMINATOR) {
        throw new Error(
            `[@guru-fund/sdk] quoteRebalance: target weights must sum to ${WEIGHT_DENOMINATOR}, got ${totalTargetWeight}`
        )
    }

    const slippageByToken = new Map(
        Object.entries(parsed.slippageSettings ?? {}).map(
            ([token, slippage]) => [token.toLowerCase(), slippage] as const
        )
    )
    const slippageE2For = (token: string): number | undefined => {
        const slippage = slippageByToken.get(token.toLowerCase())
        return slippage == null ? undefined : Number(slippage / 10n)
    }

    const totalValue = fundData.totalValueLocked

    type FundAsset = (typeof fundData.assets)[number]
    const sellAssets: { asset: FundAsset; sellAmount: bigint }[] = []
    const buyAssets: { asset: FundAsset; deltaWeight: bigint }[] = []
    let skippedDust = 0

    for (const asset of fundData.assets) {
        const targetWeight = targetWeightMap.get(
            asset.token.address.toLowerCase()
        )
        if (targetWeight === undefined) continue
        const delta = targetWeight - asset.weight
        if (delta >= -TOLERANCE && delta <= TOLERANCE) continue
        const deltaValueUsdt =
            (absBigint(delta) * totalValue) / WEIGHT_DENOMINATOR
        if (deltaValueUsdt < DUST_THRESHOLD) {
            skippedDust++
            continue
        }
        if (delta < 0n) {
            // Over-allocated: scale balance by current weight to derive the
            // amount of this asset to sell into the intermediary.
            const sellAmount = (absBigint(delta) * asset.balance) / asset.weight
            sellAssets.push({ asset, sellAmount })
        } else {
            buyAssets.push({ asset, deltaWeight: delta })
        }
    }

    const buildTxData = (
        extCalls: ExternalCallStruct[]
    ): TransactionRequest => ({
        to: controllerAddress,
        from: manager,
        data: FundController__factory.createInterface().encodeFunctionData(
            'executeTrades',
            [
                parsed.ledger,
                extCalls.map((c) => c.adapter),
                extCalls.map((c) => c.callData),
            ]
        ),
    })

    const decodeLogs: QuoteRebalanceResult['decodeLogs'] = (logs) => {
        try {
            const parser = ReceiptParser.fromSimulationLogs(logs)
            const controller = TradeController__factory.connect(
                controllerAddress,
                provider
            )

            const events = parser.getDecodedLogs(
                controller.interface,
                controller.getEvent('TradeExecuted')
            )

            return {
                trades: events.map((e) => ({
                    tokenIn: e.trade.tokenIn,
                    tokenOut: e.trade.tokenOut,
                    amountIn: e.trade.amountIn,
                    amountOut: e.trade.amountOut,
                })),
            }
        } catch {
            return null
        }
    }

    if (sellAssets.length === 0 && buyAssets.length === 0) {
        return {
            extCalls: [],
            trades: [],
            cumulativeSlippageBps: 0n,
            txData: buildTxData([]),
            decodeLogs,
            emptyReason: skippedDust > 0 ? 'dust' : 'balanced',
        }
    }

    const extCalls: ExternalCallStruct[] = []
    const trades: QuoteRebalanceTrade[] = []
    let totalUsd1e18In = 0n
    let totalUsd1e18Out = 0n

    // Each newly-validated leg is appended here; subsequent legs receive it
    // as the simulation prefix. This guarantees leg N's slippage is checked
    // against the vault state produced by legs 0..N-1, not against the raw
    // pre-rebalance state.
    const prefixTxs: PrefixTx[] = []
    const pushPrefix = (route: {
        adapter: string
        callData: string | Uint8Array
    }) => {
        prefixTxs.push({
            from: controllerAddress,
            to: vault,
            callData: encodeVaultExecute(
                String(route.adapter),
                String(route.callData)
            ),
        })
    }

    // Phase 1 — sell over-allocated assets into the USDC intermediary.
    // Legs run sequentially so each one's prefix includes the prior leg's
    // committed effect on shared pools (e.g., a second sell through the same
    // WETH/USDC pair as the first).
    let totalIntermediaryProceeds = 0n
    for (const { asset, sellAmount } of sellAssets) {
        if (compareAddresses(asset.token.address, intermediary)) {
            totalIntermediaryProceeds += sellAmount
            continue
        }
        const route = await getRouteOut(
            {
                chainId: ctx.chainId,
                tokenIn: asset.token.address,
                tokenOut: intermediary,
                amountIn: sellAmount,
                slippageE2: slippageE2For(asset.token.address),
                account: vault,
                vault,
                prefixTxs: [...prefixTxs],
            },
            ctx
        )
        const amountToReceive = BigInt(route.data.amountToReceive)
        totalIntermediaryProceeds += amountToReceive
        extCalls.push({ adapter: route.adapter, callData: route.callData })
        pushPrefix({
            adapter: String(route.adapter),
            callData: route.callData as string,
        })
        const usdIn1e18 =
            (sellAmount * asset.usd1e18Price) /
            Token.unitFor(asset.token.decimals)
        const usdOut1e18 = amountToReceive * NORMALIZER
        totalUsd1e18In += usdIn1e18
        totalUsd1e18Out += usdOut1e18
        trades.push({
            tokenIn: asset.token.address,
            tokenOut: intermediary,
            amountIn: sellAmount,
            expectedAmountOut: amountToReceive,
        })
    }

    // Phase 2 — buy under-allocated assets from intermediary proceeds. Buy
    // amounts are weighted by each delta against the total buy weight so the
    // sum of buy spends equals the actual proceeds. Each buy leg's prefix
    // includes every committed sell + every committed earlier buy, so the
    // slippage simulator runs against the correct intermediary balance and
    // post-sell pool state.
    const totalBuyWeight = buyAssets.reduce((sum, b) => sum + b.deltaWeight, 0n)
    for (const { asset, deltaWeight } of buyAssets) {
        const buyAmountIntermediary =
            totalBuyWeight === 0n
                ? 0n
                : (totalIntermediaryProceeds * deltaWeight) / totalBuyWeight
        if (compareAddresses(asset.token.address, intermediary)) continue
        const route = await getRouteIn(
            {
                chainId: ctx.chainId,
                tokenIn: intermediary,
                tokenOut: asset.token.address,
                amountIn: buyAmountIntermediary,
                slippageE2: slippageE2For(asset.token.address),
                account: vault,
                vault,
                prefixTxs: [...prefixTxs],
            },
            ctx
        )
        const amountToReceive = BigInt(route.data.amountToReceive)
        extCalls.push({ adapter: route.adapter, callData: route.callData })
        pushPrefix({
            adapter: String(route.adapter),
            callData: route.callData as string,
        })
        const usdIn1e18 = buyAmountIntermediary * NORMALIZER
        const usdOut1e18 =
            (amountToReceive * asset.usd1e18Price) /
            Token.unitFor(asset.token.decimals)
        totalUsd1e18In += usdIn1e18
        totalUsd1e18Out += usdOut1e18
        trades.push({
            tokenIn: intermediary,
            tokenOut: asset.token.address,
            amountIn: buyAmountIntermediary,
            expectedAmountOut: amountToReceive,
        })
    }

    const cumulativeSlippageBps =
        totalUsd1e18In > 0n
            ? ((totalUsd1e18In - totalUsd1e18Out) * MAX_BPS) / totalUsd1e18In
            : 0n

    return {
        extCalls,
        trades,
        cumulativeSlippageBps,
        txData: buildTxData(extCalls),
        decodeLogs,
        emptyReason: null,
    }
}
