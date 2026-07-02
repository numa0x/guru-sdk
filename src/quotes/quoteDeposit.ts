import type {
    AddressLike,
    BytesLike,
    Provider,
    TransactionRequest,
} from 'ethers'

import type { GuruProtocolChainId } from '../addresses'
import { MAX_BPS, UNIT } from '../constants'
import compareAddresses from '../helpers/compareAddresses'
import FundDataFetcher, {
    WEIGHT_DENOMINATOR,
    type GetPriceUsd1e18,
} from '../helpers/FundDataFetcher'
import ReceiptParser from '../helpers/ReceiptParser'
import { Token, type TokenMetadata } from '../helpers/Token'
import { getRouteIn, type Route, type RouterContext } from '../router'
import { quoteDepositSchema } from '../schemas/quoteDeposit'
import buildDepositTx from '../txBuilders/buildDepositTx'
import { FundLedger__factory } from '../typechain'
import type { Fund } from '../types/Fund'

export type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface QuoteDepositParams {
    ledger: string
    account: string
    coin: string
    amount: bigint
    referrerFeeBps: bigint
    /**
     * Per-asset slippage settings (e3, e.g. "500" = 0.5%). Accepted for input
     * parity with the legacy procedure and consumed by the route builder when
     * present. Keys are token addresses; values are e3 slippage budgets.
     */
    slippageSettings?: Record<string, string | number | bigint>
}

export interface QuoteDepositContext extends RouterContext {
    chainId: GuruProtocolChainId
    /** USD-1e18 price oracle injected into FundDataFetcher. */
    getPriceUsd1e18: GetPriceUsd1e18
}

export interface QuoteDepositLogs {
    expectedShares: bigint
}

export type SimulationLog = {
    address: string
    data: string
    topics: string[]
}

export interface QuoteDepositResult {
    sharesOutMin: bigint
    extCalls: ExternalCallStruct[]
    fees: bigint
    referrerFeeBps: bigint
    cumulativeSlippageBps: bigint
    perAssetSlippageBps: Record<string, bigint>
    txData: TransactionRequest
    decodeLogs: (logs: SimulationLog[]) => QuoteDepositLogs | null
}

const MAX_UINT256 = (1n << 256n) - 1n
const MIN_ROUTE_INPUT_AMOUNT = 2n
const ROUTE_AWARE_ALLOCATION_PASSES = 1

const minBigint = (a: bigint, b: bigint): bigint => (a < b ? a : b)
const slippageE2For = (
    settings: Record<string, string | number | bigint> | undefined,
    token: string
): number | undefined => {
    const slippage = settings?.[token.toLowerCase()]
    return slippage == null ? undefined : Number(BigInt(slippage) / 10n)
}

const assetUsd1e18Value = (asset: Fund.Asset): bigint =>
    (asset.usd1e18Price * asset.balance) / Token.unitFor(asset.token.decimals)

type WeightedAllocationInput = {
    key: string
    weight: bigint
    denominator: bigint
    balance: bigint
}

type DepositAllocationQuote = {
    asset: Fund.Asset
    amountIn: bigint
    amountOut: bigint
}

type DepositRouteResult = {
    asset: Fund.Asset
    amountIn: bigint
    route: Route
}

function allocateWeightedInputAmounts(
    items: WeightedAllocationInput[],
    totalAmount: bigint
): Map<string, bigint> {
    const allocations = new Map<string, bigint>()

    if (totalAmount === 0n) {
        for (const item of items) allocations.set(item.key, 0n)
        return allocations
    }

    const weighted = items.map((item) => {
        const weightedAmount = totalAmount * item.weight
        const amount =
            item.denominator === 0n ? 0n : weightedAmount / item.denominator
        return {
            ...item,
            amount,
            remainder:
                item.denominator === 0n
                    ? 0n
                    : weightedAmount % item.denominator,
        }
    })

    const allocated = weighted.reduce((sum, item) => sum + item.amount, 0n)
    let remainder = totalAmount - allocated

    weighted
        .sort((a, b) =>
            a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1
        )
        .forEach((item) => {
            const extra = remainder > 0n ? 1n : 0n
            allocations.set(item.key, item.amount + extra)
            remainder -= extra
        })

    const zeroRoundedAssets = weighted
        .filter(
            (item) => item.balance > 0n && (allocations.get(item.key) ?? 0n) === 0n
        )
        .sort((a, b) =>
            a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1
        )

    for (const item of zeroRoundedAssets) {
        const donor = weighted
            .filter((candidate) => candidate.key !== item.key)
            .sort((a, b) => {
                const aAmount = allocations.get(a.key) ?? 0n
                const bAmount = allocations.get(b.key) ?? 0n
                return aAmount === bAmount ? 0 : aAmount > bAmount ? -1 : 1
            })
            .find(
                (candidate) =>
                    (allocations.get(candidate.key) ?? 0n) >
                    MIN_ROUTE_INPUT_AMOUNT
            )

        if (!donor) break

        allocations.set(
            donor.key,
            (allocations.get(donor.key) ?? 0n) - MIN_ROUTE_INPUT_AMOUNT
        )
        allocations.set(item.key, MIN_ROUTE_INPUT_AMOUNT)
    }

    return allocations
}

export function allocateDepositInputAmounts(
    assets: Fund.Asset[],
    totalAmount: bigint,
    totalValueLocked: bigint
): Map<string, bigint> {
    if (totalAmount === 0n || totalValueLocked === 0n) {
        const allocations = new Map<string, bigint>()
        for (const asset of assets) {
            allocations.set(asset.token.address.toLowerCase(), 0n)
        }
        return allocations
    }

    return allocateWeightedInputAmounts(
        assets.map((asset) => ({
            key: asset.token.address.toLowerCase(),
            weight: assetUsd1e18Value(asset),
            denominator: totalValueLocked,
            balance: asset.balance,
        })),
        totalAmount
    )
}

export function rebalanceDepositInputAmounts(
    quotes: DepositAllocationQuote[],
    totalAmount: bigint
): Map<string, bigint> {
    let denominator = 0n
    const weights = quotes.map(({ asset, amountIn, amountOut }) => {
        let weight = 0n
        if (asset.balance > 0n && amountIn > 0n && amountOut > 0n) {
            const inputRatio = (amountOut * UNIT) / asset.balance
            if (inputRatio > 0n) {
                weight = (amountIn * UNIT) / inputRatio
            }
        }
        denominator += weight
        return {
            key: asset.token.address.toLowerCase(),
            weight,
            denominator: 0n,
            balance: asset.balance,
        }
    })

    if (denominator === 0n) {
        return new Map(
            quotes.map(({ asset, amountIn }) => [
                asset.token.address.toLowerCase(),
                amountIn,
            ])
        )
    }

    return allocateWeightedInputAmounts(
        weights.map((item) => ({ ...item, denominator })),
        totalAmount
    )
}

function allocationsEqual(
    a: Map<string, bigint>,
    b: Map<string, bigint>
): boolean {
    if (a.size !== b.size) return false
    for (const [key, value] of a) {
        if (b.get(key) !== value) return false
    }
    return true
}

async function quoteDepositAllocations({
    inputAllocations,
    coinData,
    fundData,
    parsed,
    ctx,
    vault,
}: {
    inputAllocations: Map<string, bigint>
    coinData: Fund.Asset | undefined
    fundData: Fund.Overview
    parsed: QuoteDepositParams
    ctx: QuoteDepositContext
    vault: string
}): Promise<{
    allocationQuotes: DepositAllocationQuote[]
    routeResults: DepositRouteResult[]
}> {
    const allocationQuotes: DepositAllocationQuote[] = []

    if (coinData) {
        const amountIn =
            inputAllocations.get(coinData.token.address.toLowerCase()) ?? 0n
        if (coinData.balance > 0n && amountIn === 0n) {
            throw new Error(
                `Deposit amount is too small to allocate input for asset ${coinData.token.address}`
            )
        }
        allocationQuotes.push({
            asset: coinData,
            amountIn,
            amountOut: amountIn,
        })
    }

    const assetsToSwap = fundData.assets.filter(
        (asset) => !compareAddresses(asset.token.address, parsed.coin)
    )
    const routeResults = await Promise.all(
        assetsToSwap.map(async (asset) => {
            const amountIn =
                inputAllocations.get(asset.token.address.toLowerCase()) ?? 0n
            if (asset.balance > 0n && amountIn === 0n) {
                throw new Error(
                    `Deposit amount is too small to allocate input for asset ${asset.token.address}`
                )
            }
            const route = await getRouteIn(
                {
                    chainId: ctx.chainId,
                    tokenIn: parsed.coin,
                    tokenOut: asset.token.address,
                    amountIn,
                    account: parsed.account,
                    vault,
                    slippageE2: slippageE2For(
                        parsed.slippageSettings,
                        asset.token.address
                    ),
                },
                ctx
            )
            allocationQuotes.push({
                asset,
                amountIn,
                amountOut: BigInt(route.data.amountToReceive),
            })
            return { asset, amountIn, route }
        })
    )

    return { allocationQuotes, routeResults }
}

export default async function quoteDeposit(
    params: QuoteDepositParams,
    ctx: QuoteDepositContext
): Promise<QuoteDepositResult> {
    const parsed = quoteDepositSchema.parse(params)

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

    const [fundData, vault, controllerAddress] = await Promise.all([
        fetcher.fetchFundData(ledger),
        ledger.vault(),
        ledger.controller(),
    ])

    const referrerFeeBps = parsed.referrerFeeBps
    const originalAmount = parsed.amount
    let fees = (originalAmount * referrerFeeBps) / MAX_BPS
    const adjustedAmount = originalAmount - fees

    const coinData = fundData.assets.find((asset) =>
        compareAddresses(asset.token.address, parsed.coin)
    )

    let inputAllocations = allocateDepositInputAmounts(
        fundData.assets,
        adjustedAmount,
        fundData.totalValueLocked
    )

    let quoted = await quoteDepositAllocations({
        inputAllocations,
        coinData,
        fundData,
        parsed,
        ctx,
        vault,
    })

    for (let i = 0; i < ROUTE_AWARE_ALLOCATION_PASSES; i++) {
        const rebalanced = rebalanceDepositInputAmounts(
            quoted.allocationQuotes,
            adjustedAmount
        )
        if (allocationsEqual(inputAllocations, rebalanced)) break
        inputAllocations = rebalanced
        quoted = await quoteDepositAllocations({
            inputAllocations,
            coinData,
            fundData,
            parsed,
            ctx,
            vault,
        })
    }

    let lowestInputRatio = MAX_UINT256
    for (const { asset, amountOut } of quoted.allocationQuotes) {
        if (asset.balance === 0n) continue
        lowestInputRatio = minBigint(
            lowestInputRatio,
            (amountOut * UNIT) / asset.balance
        )
    }

    const routeResults = quoted.routeResults

    const coinToken = await new Token(parsed.coin, provider).metadata()
    const coinUsd1e18Price = await ctx.getPriceUsd1e18(parsed.coin)
    const externalTokenMetadata = new Map<string, TokenMetadata>()
    const externalUsd1e18Prices = new Map<string, bigint>()

    const getTokenMetadata = async (
        address: string
    ): Promise<TokenMetadata> => {
        const existingAsset = fundData.assets.find((asset) =>
            compareAddresses(asset.token.address, address)
        )
        if (existingAsset) return existingAsset.token

        const key = address.toLowerCase()
        const cached = externalTokenMetadata.get(key)
        if (cached) return cached

        const metadata = await new Token(address, provider).metadata()
        externalTokenMetadata.set(key, metadata)
        return metadata
    }

    const getUsd1e18Price = async (address: string): Promise<bigint> => {
        const existingAsset = fundData.assets.find((asset) =>
            compareAddresses(asset.token.address, address)
        )
        if (existingAsset) return existingAsset.usd1e18Price

        const key = address.toLowerCase()
        const cached = externalUsd1e18Prices.get(key)
        if (cached != null) return cached

        const price = await ctx.getPriceUsd1e18(address)
        externalUsd1e18Prices.set(key, price)
        return price
    }

    const tollToCoinUnits = async (
        amount: bigint,
        currency: AddressLike
    ): Promise<bigint> => {
        const currencyAddress = String(currency)
        if (amount === 0n || compareAddresses(currencyAddress, parsed.coin)) {
            return amount
        }
        if (coinUsd1e18Price === 0n) return 0n

        const [tollToken, tollUsd1e18Price] = await Promise.all([
            getTokenMetadata(currencyAddress),
            getUsd1e18Price(currencyAddress),
        ])

        const tollUsd1e18 =
            (amount * tollUsd1e18Price) / Token.unitFor(tollToken.decimals)
        return (
            (tollUsd1e18 * Token.unitFor(coinToken.decimals)) / coinUsd1e18Price
        )
    }

    const extCalls: ExternalCallStruct[] = []
    const perAssetSlippageBps: Record<string, bigint> = {}
    let cumulativeSlippageBps = 0n
    for (const { asset, route } of routeResults) {
        extCalls.push({
            adapter: route.adapter,
            callData: route.callData,
        })
        fees += await tollToCoinUnits(route.toll.amount, route.toll.currency)
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

    const sharesOutMin = (fundData.tokenTotalSupply * lowestInputRatio) / UNIT

    const txData = buildDepositTx({
        controller: controllerAddress,
        ledger: parsed.ledger,
        coin: parsed.coin,
        amount: originalAmount,
        sharesOutMin,
        extCalls,
        referrerFeeBps,
        from: parsed.account,
    })

    const depositedEvent = ledger.getEvent('Deposited')
    const decodeLogs: QuoteDepositResult['decodeLogs'] = (logs) => {
        try {
            const parser = ReceiptParser.fromSimulationLogs(logs)
            const deposited = parser.getDecodedLog(
                ledger.interface,
                depositedEvent
            )
            return { expectedShares: deposited.shares }
        } catch {
            return null
        }
    }

    return {
        sharesOutMin,
        extCalls,
        fees,
        referrerFeeBps,
        cumulativeSlippageBps,
        perAssetSlippageBps,
        txData,
        decodeLogs,
    }
}
