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
import { getRouteIn, type RouterContext } from '../router'
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

export function allocateDepositInputAmounts(
    assets: Fund.Asset[],
    totalAmount: bigint,
    totalValueLocked: bigint
): Map<string, bigint> {
    const allocations = new Map<string, bigint>()
    if (totalAmount === 0n || totalValueLocked === 0n) {
        for (const asset of assets) {
            allocations.set(asset.token.address.toLowerCase(), 0n)
        }
        return allocations
    }

    const weighted = assets.map((asset) => {
        const usdValue = assetUsd1e18Value(asset)
        const weightedAmount = totalAmount * usdValue
        const amount = weightedAmount / totalValueLocked
        return {
            asset,
            amount,
            remainder: weightedAmount % totalValueLocked,
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
            allocations.set(
                item.asset.token.address.toLowerCase(),
                item.amount + extra
            )
            remainder -= extra
        })

    return allocations
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

    const inputAllocations = allocateDepositInputAmounts(
        fundData.assets,
        adjustedAmount,
        fundData.totalValueLocked
    )

    const coinInputAmount = coinData
        ? (inputAllocations.get(coinData.token.address.toLowerCase()) ?? 0n)
        : 0n
    if (coinData && coinData.balance > 0n && coinInputAmount === 0n) {
        throw new Error(
            `Deposit amount is too small to allocate input for asset ${coinData.token.address}`
        )
    }

    let lowestInputRatio =
        coinData && coinData.balance > 0n
            ? (coinInputAmount * UNIT) / coinData.balance
            : MAX_UINT256

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
                },
                ctx
            )
            return { asset, route }
        })
    )

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
        lowestInputRatio = minBigint(
            lowestInputRatio,
            (BigInt(route.data.amountToReceive) * UNIT) / asset.balance
        )
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
