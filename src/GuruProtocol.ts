import { JsonRpcProvider, type Provider } from 'ethers'

import {
    getGuruProtocolAddresses,
    isSupportedChainId,
    UnsupportedChainError,
    type GuruProtocolAddresses,
    type GuruProtocolChainId,
} from './addresses'
import type { GetPriceUsd1e18 } from './helpers/FundDataFetcher'
import quoteDeposit, {
    type QuoteDepositParams,
    type QuoteDepositResult,
} from './quotes/quoteDeposit'
import quoteHarvest, {
    type QuoteHarvestParams,
    type QuoteHarvestResult,
} from './quotes/quoteHarvest'
import quoteRebalance, {
    type QuoteRebalanceParams,
    type QuoteRebalanceResult,
} from './quotes/quoteRebalance'
import quoteTrade, {
    type QuoteTradeParams,
    type QuoteTradeResult,
} from './quotes/quoteTrade'
import quoteWithdrawal, {
    type QuoteWithdrawalParams,
    type QuoteWithdrawalResult,
} from './quotes/quoteWithdrawal'
import { getPriceUsd1e18 as defaultGetPriceUsd1e18 } from './router'
import { getPath as defaultGetPath, type PathFetcher } from './router/pathCache'
import type { SwapSimulator } from './router/simulation'
import buildDepositTx from './txBuilders/buildDepositTx'
import buildHarvestTx from './txBuilders/buildHarvestTx'
import buildTradeTx from './txBuilders/buildTradeTx'
import buildWithdrawTx from './txBuilders/buildWithdrawTx'

export interface GuruProtocolOptions {
    rpcUrl: string
    chainId: number
    /**
     * Optional swap simulator. The Velora primary router uses a simulator to
     * find the highest amountOut that survives sandwich-aware on-chain
     * conditions. Default returns `{ success: false }`, which makes Velora
     * fall back to the caller-supplied slippage. apps/trpc cutover injects
     * the Alchemy → Tenderly fallback chain via this slot.
     */
    simulator?: SwapSimulator
    /**
     * Optional override for the protocol swap fee read used by the
     * PoolHelper fallback path. Defaults to `200n` (matches the legacy
     * apps/trpc fallback's hardcoded value).
     */
    getSwapFeePercentage?: () => Promise<bigint>
    /**
     * Optional override for the per-token USD-1e18 price oracle used by
     * FundDataFetcher. Defaults to the SDK's PoolHelper-based on-chain
     * oracle (1 WETH → USDT, then per-token → WETH).
     */
    getPriceUsd1e18?: GetPriceUsd1e18
    /**
     * Override the Velora API endpoint URL. Takes effect when using the default
     * path-fetching logic. Ignored if `getPath` is provided.
     */
    veloraEndpoint?: string
    /**
     * Completely override the swap-path discovery logic. The default fetches
     * paths from Velora's DEX aggregator API. Use this to integrate a different
     * routing backend or to stub paths in tests.
     */
    getPath?: PathFetcher
}

const noopSimulator: SwapSimulator = async () => ({ success: false })

const defaultSwapFeePercentage = async (): Promise<bigint> => 200n

/**
 * Single entry point for the Guru Protocol SDK. Construct one per chain.
 *
 * ```ts
 * const protocol = new GuruProtocol({
 *     rpcUrl: 'https://mainnet.infura.io/v3/...',
 *     chainId: 1,
 * })
 * const quote = await protocol.quoteDeposit({
 *     ledger, account, coin, amount, referrerFeeBps: 0n,
 * })
 * ```
 *
 * The constructor builds an internal `JsonRpcProvider(rpcUrl)`; do not pass
 * a provider in. All Guru Protocol contract addresses resolve from the SDK's
 * vendored registry — there is no contracts input.
 */
export class GuruProtocol {
    public readonly chainId: GuruProtocolChainId
    public readonly addresses: GuruProtocolAddresses
    public readonly provider: Provider

    private readonly simulator: SwapSimulator
    private readonly getSwapFeePercentageFn: () => Promise<bigint>
    private readonly getPriceUsd1e18Fn: GetPriceUsd1e18
    private readonly getPathFn: PathFetcher

    constructor(options: GuruProtocolOptions) {
        if (!isSupportedChainId(options.chainId)) {
            throw new UnsupportedChainError(options.chainId)
        }
        this.chainId = options.chainId
        this.addresses = getGuruProtocolAddresses(options.chainId)
        this.provider = new JsonRpcProvider(options.rpcUrl)
        this.simulator = options.simulator ?? noopSimulator
        this.getSwapFeePercentageFn =
            options.getSwapFeePercentage ?? defaultSwapFeePercentage
        this.getPriceUsd1e18Fn =
            options.getPriceUsd1e18 ??
            ((token) =>
                defaultGetPriceUsd1e18(token, {
                    chainId: this.chainId,
                    provider: this.provider,
                    getSwapFeePercentage: this.getSwapFeePercentageFn,
                }))
        this.getPathFn =
            options.getPath ??
            ((params) => defaultGetPath(params, options.veloraEndpoint))
    }

    private routerCtx() {
        return {
            chainId: this.chainId,
            provider: this.provider,
            simulator: this.simulator,
            getSwapFeePercentage: this.getSwapFeePercentageFn,
            getPriceUsd1e18: this.getPriceUsd1e18Fn,
            getPath: this.getPathFn,
        }
    }

    quoteDeposit(params: QuoteDepositParams): Promise<QuoteDepositResult> {
        return quoteDeposit(params, this.routerCtx())
    }

    quoteWithdrawal(
        params: QuoteWithdrawalParams
    ): Promise<QuoteWithdrawalResult> {
        return quoteWithdrawal(params, this.routerCtx())
    }

    quoteTrade(params: QuoteTradeParams): Promise<QuoteTradeResult> {
        return quoteTrade(params, this.routerCtx())
    }

    quoteHarvest(params: QuoteHarvestParams): Promise<QuoteHarvestResult> {
        return quoteHarvest(params, this.routerCtx())
    }

    quoteRebalance(
        params: QuoteRebalanceParams
    ): Promise<QuoteRebalanceResult> {
        return quoteRebalance(params, this.routerCtx())
    }

    static buildDepositTx = buildDepositTx
    static buildWithdrawTx = buildWithdrawTx
    static buildHarvestTx = buildHarvestTx
    static buildTradeTx = buildTradeTx
}

export default GuruProtocol
