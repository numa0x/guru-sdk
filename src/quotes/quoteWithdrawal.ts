import type {
    AddressLike,
    BytesLike,
    Provider,
    TransactionRequest,
} from 'ethers'

import type { GuruProtocolChainId } from '../addresses'
import { MAX_BPS, SECONDS_PER_YEAR } from '../constants'
import compareAddresses from '../helpers/compareAddresses'
import { Token } from '../helpers/Token'
import FundDataFetcher, {
    WEIGHT_DENOMINATOR,
    type GetPriceUsd1e18,
} from '../helpers/FundDataFetcher'
import ReceiptParser from '../helpers/ReceiptParser'
import { getRouteOut, type RouterContext } from '../router'
import type { Route } from '../router/types'
import { quoteWithdrawalSchema } from '../schemas/quoteWithdrawal'
import buildWithdrawTx from '../txBuilders/buildWithdrawTx'
import { FundLedger__factory } from '../typechain'

export type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface QuoteWithdrawalParams {
    ledger: string
    account: string
    shares: bigint
    coin: string
    /**
     * Required. Mirrors the deposit flow: callers retain referrer-fee policy
     * decisions (today the apps/trpc layer always passes 0n; the SDK validates
     * range so an accidentally non-zero value can't sneak through).
     */
    referrerFeeBps: bigint
    /**
     * Per-asset slippage settings (e3, e.g. "500" = 0.5%). Accepted for input
     * parity with the legacy procedure and consumed by the route builder when
     * present. Keys are token addresses; values are e3 slippage budgets.
     */
    slippageSettings?: Record<string, string | number | bigint>
}

export interface QuoteWithdrawalContext extends RouterContext {
    chainId: GuruProtocolChainId
    /** USD-1e18 price oracle injected into FundDataFetcher. */
    getPriceUsd1e18: GetPriceUsd1e18
}

export interface QuoteWithdrawalLogs {
    netAmountOut: bigint
    managerFee: bigint
}

export type SimulationLog = {
    address: string
    data: string
    topics: string[]
}

export interface QuoteWithdrawalResult {
    proceeds: bigint
    extCalls: ExternalCallStruct[]
    routing: Route['data'][]
    referrerFeeBps: bigint
    cumulativeSlippageBps: bigint
    perAssetSlippageBps: Record<string, bigint>
    txData: TransactionRequest
    decodeLogs: (logs: SimulationLog[]) => QuoteWithdrawalLogs | null
}

// 2% yearly management fee accrual horizon used to reserve a buffer in
// per-asset amountIn so the on-chain checkpoint doesn't push amountIn over
// maxAssetsOut between quote-time and submission-time.
const MANAGEMENT_FEE_BPS = 200n
const MANAGEMENT_FEE_HORIZON_SECONDS = 300n
const slippageE2For = (
    settings: Record<string, string | number | bigint> | undefined,
    token: string
): number | undefined => {
    const slippage = settings?.[token.toLowerCase()]
    return slippage == null ? undefined : Number(BigInt(slippage) / 10n)
}

export default async function quoteWithdrawal(
    params: QuoteWithdrawalParams,
    ctx: QuoteWithdrawalContext
): Promise<QuoteWithdrawalResult> {
    const parsed = quoteWithdrawalSchema.parse(params)

    if (parsed.referrerFeeBps < 0n || parsed.referrerFeeBps > MAX_BPS) {
        throw new Error(
            `referrerFeeBps must be between 0 and ${MAX_BPS}, got ${parsed.referrerFeeBps}`
        )
    }

    const provider: Provider = ctx.provider
    const ledger = FundLedger__factory.connect(parsed.ledger, provider)

    const fetcher = new FundDataFetcher({
        chainId: ctx.chainId,
        provider,
        getPriceUsd1e18: ctx.getPriceUsd1e18,
    })

    const [
        fundData,
        vault,
        controllerAddress,
        viewBalance,
        rawBalance,
        rawTotalSupply,
        totalSupplyOffset,
    ] = await Promise.all([
        fetcher.fetchFundData(ledger),
        ledger.vault(),
        ledger.controller(),
        ledger.balanceOf(parsed.account),
        ledger.preAdjustedBalanceOf(parsed.account),
        ledger.rawTotalSupply(),
        ledger.totalSupplyOffset(),
    ])

    const stablecoinBalance = await new Token(parsed.coin, provider).balanceOf(
        vault
    )

    // The on-chain withdrawal runs _epochCheckpoint() BEFORE reading
    // rawTotalSupply() for maxAssetsOut validation. The checkpoint:
    //   1. Accrues pending management fees (mints shares → rawTotalSupply increases)
    //   2. Adjusts user balance to target (mints/burns → rawTotalSupply changes, offset compensates)
    // We must match this post-checkpoint rawTotalSupply as our divisor,
    // otherwise amountIn may exceed maxAssetsOut → ExcessAmountsOut revert.
    const pendingMgmtFees =
        fundData.tokenTotalSupply - rawTotalSupply - totalSupplyOffset
    const checkpointDelta = viewBalance - rawBalance
    const effectiveSupply = rawTotalSupply + pendingMgmtFees + checkpointDelta

    let proceeds = (parsed.shares * stablecoinBalance) / effectiveSupply

    const routing: Route['data'][] = []
    const extCalls: ExternalCallStruct[] = []

    const assetsToSwap = fundData.assets.filter(
        (asset) => !compareAddresses(asset.token.address, parsed.coin)
    )

    const routeResults = await Promise.all(
        assetsToSwap.map(async (asset) => {
            const amountIn = (parsed.shares * asset.balance) / effectiveSupply
            const mgmtFeeBuffer =
                (amountIn *
                    MANAGEMENT_FEE_BPS *
                    MANAGEMENT_FEE_HORIZON_SECONDS) /
                (MAX_BPS * SECONDS_PER_YEAR)
            const route = await getRouteOut(
                {
                    chainId: ctx.chainId,
                    tokenIn: asset.token.address,
                    tokenOut: parsed.coin,
                    amountIn: amountIn - mgmtFeeBuffer,
                    slippageE2: slippageE2For(
                        parsed.slippageSettings,
                        asset.token.address
                    ),
                    account: parsed.account,
                    vault,
                },
                ctx
            )
            return { asset, route }
        })
    )

    const perAssetSlippageBps: Record<string, bigint> = {}
    let cumulativeSlippageBps = 0n
    for (const { asset, route } of routeResults) {
        routing.push(route.data)
        extCalls.push({
            adapter: route.adapter,
            callData: route.callData,
        })
        proceeds += BigInt(route.data.amountToReceive)

        const bps = route.effectiveSlippageBps
        if (bps != null) {
            const bpsN = BigInt(bps)
            const assetKey = asset.token.address.toLowerCase()
            perAssetSlippageBps[assetKey] = bpsN
            // Cumulative slippage S = ∑ (s_i * w_i); weight is in
            // WEIGHT_DENOMINATOR basis, so divide back out.
            cumulativeSlippageBps += (bpsN * asset.weight) / WEIGHT_DENOMINATOR
        }
    }

    const referrerFeeBps = parsed.referrerFeeBps
    const txData = buildWithdrawTx({
        controller: controllerAddress,
        ledger: parsed.ledger,
        coin: parsed.coin,
        shares: parsed.shares,
        extCalls,
        referrerFeeBps,
        from: parsed.account,
    })

    const withdrawnEvent = ledger.getEvent('Withdrawn')
    const decodeLogs: QuoteWithdrawalResult['decodeLogs'] = (logs) => {
        try {
            const parser = ReceiptParser.fromSimulationLogs(logs)
            const withdrawn = parser.getDecodedLog(
                ledger.interface,
                withdrawnEvent
            )
            return {
                netAmountOut: withdrawn.netAmountOut,
                managerFee: withdrawn.managerFee,
            }
        } catch {
            return null
        }
    }

    return {
        proceeds,
        extCalls,
        routing,
        referrerFeeBps,
        cumulativeSlippageBps,
        perAssetSlippageBps,
        txData,
        decodeLogs,
    }
}
