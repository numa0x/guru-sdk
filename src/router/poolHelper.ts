import {
    BytesLike,
    Contract,
    ZeroAddress,
    solidityPacked,
    type ContractRunner,
    type Provider,
} from 'ethers'

import {
    getGuruProtocolAddresses,
    isSupportedChainId,
    type GuruProtocolAddresses,
    type GuruProtocolChainId,
} from '../addresses'
import compareAddresses from '../helpers/compareAddresses'
import { Token } from '../helpers/Token'
import {
    AerodromeV2Adapter__factory,
    IPancakeQuoterV2__factory,
    UniswapV2Adapter__factory,
    UniswapV3Adapter__factory,
} from '../typechain'
import type { SwapAeroV2Struct } from '../typechain/out/AerodromeV2Adapter'
import type { SwapV2Struct } from '../typechain/out/UniswapV2Adapter'
import type { SwapV3Struct } from '../typechain/out/UniswapV3Adapter'
import { finalizeRouteQuote } from './finalizeRoute'
import type {
    PrefixTx,
    SwapSimulationContext,
    SwapSimulator,
} from './simulation'
import type { V2Path, V3Path } from './types'

// ─── SwapType + FeeTier (vendored SDK-internal copies) ───────────────────────

export const SwapType = Object.freeze({
    EXACT_INPUT: 0n,
    EXACT_OUTPUT: 1n,
})
export type SwapType = (typeof SwapType)[keyof typeof SwapType]

// Covers V2 (0), Uniswap V3 (100/500/3000/10000), PancakeSwap V3 (2500),
// Aerodrome V3 tick spacings (1/50/100/200).
export type FeeTier = 0 | 1 | 50 | 100 | 200 | 500 | 2500 | 3000 | 10000

// ─── Minimal ABIs for contracts not vendored into SDK typechain ──────────────
// Follows the US-008 pattern: inline single/few-method ABIs through
// `new ethers.Contract(...)` + a structural interface, rather than vendoring
// full typechain factories the SDK only uses sparingly.

const V2_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
    'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)',
] as const

interface V2RouterLike {
    getAmountsOut: (amountIn: bigint, path: string[]) => Promise<bigint[]>
    getAmountsIn: (amountOut: bigint, path: string[]) => Promise<bigint[]>
}

const V2_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) view returns (address pair)',
] as const

interface V2FactoryLike {
    getPair: (tokenA: string, tokenB: string) => Promise<string>
}

const V2_PAIR_ABI = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
] as const

interface V2PairLike {
    getReserves: () => Promise<[bigint, bigint, bigint]>
}

const V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
] as const

interface V3FactoryLike {
    getPool: (tokenA: string, tokenB: string, fee: number) => Promise<string>
}

const V3_POOL_ABI = ['function fee() view returns (uint24)'] as const

interface V3PoolLike {
    fee: () => Promise<bigint>
}

const AERO_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
] as const

interface AeroFactoryLike {
    getPool: (
        tokenA: string,
        tokenB: string,
        stable: boolean
    ) => Promise<string>
}

const AERO_V2_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
] as const

export type AeroRoute = {
    from: string
    to: string
    stable: boolean
    factory: string
}

interface AeroV2RouterLike {
    getAmountsOut: (amountIn: bigint, routes: AeroRoute[]) => Promise<bigint[]>
}

const AERO_V3_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
    'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
] as const

interface AeroV3QuoterLike {
    quoteExactInputSingle: {
        staticCall: (params: {
            tokenIn: string
            tokenOut: string
            amountIn: bigint
            tickSpacing: bigint
            sqrtPriceLimitX96: bigint
        }) => Promise<{
            amountOut: bigint
            sqrtPriceX96After: bigint
            initializedTicksCrossed: bigint
            gasEstimate: bigint
        }>
    }
    quoteExactOutputSingle: {
        staticCall: (params: {
            tokenIn: string
            tokenOut: string
            amount: bigint
            tickSpacing: bigint
            sqrtPriceLimitX96: bigint
        }) => Promise<{
            amountIn: bigint
            sqrtPriceX96After: bigint
            initializedTicksCrossed: bigint
            gasEstimate: bigint
        }>
    }
}

const V3_POOL_TICKSPACING_ABI = [
    'function tickSpacing() view returns (int24)',
] as const

interface V3PoolTickSpacingLike {
    tickSpacing: () => Promise<bigint>
}

function connect<T>(
    address: string,
    abi: readonly string[],
    runner?: ContractRunner | null
): T {
    return new Contract(
        address,
        abi as unknown as string[],
        runner
    ) as unknown as T
}

// ─── Error codes ─────────────────────────────────────────────────────────────

enum PoolHelperError {
    NO_ROUTE_FOUND = 'NO_ROUTE_FOUND',
    NETWORK_NOT_SUPPORTED = 'NETWORK_NOT_SUPPORTED',
    EXCHANGE_INCOMPATIBLE = 'EXCHANGE_INCOMPATIBLE',
    NO_POOL_ADDRESS = 'NO_POOL_ADDRESS',
    LOTUS_ADAPTER_MISSING = 'LOTUS_ADAPTER_MISSING',
}

// ─── DEX config (built from SDK address registry per chain) ──────────────────

type V2DexData = {
    type: 'v2'
    router: string
    kind: 'uniswap' | 'aerodrome'
    /** True iff a Guru Protocol adapter is deployed for this DEX on this chain. */
    swappable: boolean
}

type V3DexData = {
    type: 'v3'
    router?: string
    quoter: string
    feeTiers: number[]
    kind: 'uniswap' | 'aerodrome'
    /** True iff a Guru Protocol adapter is deployed for this DEX on this chain. */
    swappable: boolean
}

type DexData = V2DexData | V3DexData

type DexTable = Record<string, DexData>

// Fee tiers mirror evm/helpers/PoolHelper.ts exactly.
const UNIV3_FEE_TIERS = [100, 500, 3000, 10000]
const PANCAKEV3_FEE_TIERS = [100, 500, 2500, 10000]
const AEROV3_FEE_TIERS = [1, 50, 100, 200] // Aerodrome uses tick spacing

function buildDexTable(addresses: GuruProtocolAddresses): DexTable {
    const table: DexTable = {}

    // Register every DEX that the chain has factory + router/quoter for, so
    // pricing helpers (`getPriceUsd1e18`) can pick the deepest pool even on
    // DEXes the protocol can't yet swap through. Each entry carries a
    // `swappable` flag — swap-routing callers (`quoteWethTrade` etc.) restrict
    // pool discovery to swappable entries via `getBestQuote({requireSwappable})`.
    if (addresses.factories.uniswapV2 && addresses.routers.uniswapV2) {
        table[addresses.factories.uniswapV2.toLowerCase()] = {
            type: 'v2',
            router: addresses.routers.uniswapV2,
            kind: 'uniswap',
            swappable: Boolean(addresses.adapters.uniswapV2),
        }
    }
    if (addresses.factories.uniswapV3 && addresses.quoters.uniswapV3) {
        table[addresses.factories.uniswapV3.toLowerCase()] = {
            type: 'v3',
            router: addresses.routers.uniswapV3,
            quoter: addresses.quoters.uniswapV3,
            feeTiers: UNIV3_FEE_TIERS,
            kind: 'uniswap',
            swappable: Boolean(addresses.adapters.uniswapV3),
        }
    }
    if (addresses.factories.pancakeV2 && addresses.routers.pancakeV2) {
        table[addresses.factories.pancakeV2.toLowerCase()] = {
            type: 'v2',
            router: addresses.routers.pancakeV2,
            kind: 'uniswap',
            swappable: Boolean(addresses.adapters.pancakeV2),
        }
    }
    if (addresses.factories.pancakeV3 && addresses.quoters.pancakeV3) {
        table[addresses.factories.pancakeV3.toLowerCase()] = {
            type: 'v3',
            router: addresses.routers.pancakeV3,
            quoter: addresses.quoters.pancakeV3,
            feeTiers: PANCAKEV3_FEE_TIERS,
            kind: 'uniswap',
            swappable: Boolean(addresses.adapters.pancakeV3),
        }
    }
    if (addresses.factories.aerodromeV2 && addresses.routers.aerodromeV2) {
        table[addresses.factories.aerodromeV2.toLowerCase()] = {
            type: 'v2',
            router: addresses.routers.aerodromeV2,
            kind: 'aerodrome',
            swappable: Boolean(addresses.adapters.aerodromeV2),
        }
    }
    if (addresses.factories.aerodromeV3 && addresses.quoters.aerodromeV3) {
        const v3: V3DexData = {
            type: 'v3',
            router: addresses.routers.aerodromeV3,
            quoter: addresses.quoters.aerodromeV3,
            feeTiers: AEROV3_FEE_TIERS,
            kind: 'aerodrome',
            swappable: Boolean(addresses.adapters.aerodromeV3),
        }
        table[addresses.factories.aerodromeV3.toLowerCase()] = v3
        // Aerodrome CL deployed a second factory (`aerodromeV3Bis`) that shares
        // router/quoter/adapter with the primary CL factory.
        if (addresses.factories.aerodromeV3Bis) {
            table[addresses.factories.aerodromeV3Bis.toLowerCase()] = v3
        }
    }

    return table
}

// ─── Pool shape + V2/V3 quote-request shapes (SDK-internal) ──────────────────

export type Pool = {
    address: string
    feeTier: FeeTier
    exchangeFactory: string
    wethBalance: bigint
}

type Quote = {
    feeTier: FeeTier
    amount: bigint
    swapFee: bigint
    router: string
    exchangeFactory: string
    poolAddress?: string
    tickSpacing?: bigint
}

export type QuoteRequest = {
    swapType?: SwapType
    tokenAmount: bigint
    slippage?: bigint
    path: [string, string]
    /**
     * When true (default), pool discovery only considers DEXes that have a
     * Guru Protocol adapter on this chain — required for any caller that intends to
     * encode/execute the swap. Pricing-only callers can opt out with `false`.
     */
    requireSwappable?: boolean
}

type VersionSpecificQuoteRequest = Omit<QuoteRequest, 'path' | 'slippage'> & {
    exchangeFactory: string
    feeTier: FeeTier
    path: [string, string]
    slippage: bigint
    poolAddress?: string
}

export type StableQuoteRequest = {
    path: [string, string] | [string, string, string]
    inputAmount: bigint
    slippage: bigint
    exchangeFactory: string
    finalization?: PoolRouteFinalizationContext
}

export type StableQuoteResult = {
    adapter: string
    data: SwapV2Struct | SwapV3Struct | SwapAeroV2Struct
    callData: BytesLike
    toll: { currency: string; amount: bigint }
    effectiveSlippageBps?: string
}

export interface PoolRouteFinalizationContext {
    blockNumber: number
    controller: string
    vault: string
    account: string
    simulator: SwapSimulator
    prefixTxs?: PrefixTx[]
    maxSlippageE3?: bigint
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PERCENT_DENOMINATOR = 100_000n
const CACHE_DURATION = 60 * 60 * 1000 // 1 hour in ms

// ─── withSlippageTolerance (local copy; matches router/helpers.ts) ───────────

function withSlippageTolerance(amount: bigint, slippage: bigint): bigint {
    const tolerance = (amount * slippage) / PERCENT_DENOMINATOR
    return amount - tolerance
}

function calcSlippageTolerance(amount: bigint, slippage: bigint): bigint {
    return (amount * slippage) / PERCENT_DENOMINATOR
}

function lastAmount(amounts: bigint[], context: string): bigint {
    const amount = amounts.at(-1)
    if (amount == null) {
        throw new Error(
            `${PoolHelperError.NO_ROUTE_FOUND}: empty quote (${context})`
        )
    }
    return amount
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildAerodromeV2Routes(path: string[], factory: string): AeroRoute[] {
    return path.slice(0, -1).map((token, i) => ({
        from: token,
        to: path[i + 1],
        stable: false,
        factory,
    }))
}

// ─── PoolHelper class ────────────────────────────────────────────────────────

/**
 * SDK fallback router
 */
export default class PoolHelper {
    public readonly chainId: GuruProtocolChainId
    public readonly addresses: GuruProtocolAddresses
    protected readonly provider: Provider
    private readonly getSwapFeePercentage: () => Promise<bigint>
    private readonly dexTable: DexTable
    private readonly poolsCache: Record<
        string,
        { timestamp: number; pools: Pool[] }
    > = {}

    constructor(config: {
        chainId: number
        provider: Provider
        getSwapFeePercentage: () => Promise<bigint>
    }) {
        if (!isSupportedChainId(config.chainId)) {
            throw new Error(
                `${PoolHelperError.NETWORK_NOT_SUPPORTED}: chainId=${config.chainId}`
            )
        }
        this.chainId = config.chainId
        this.addresses = getGuruProtocolAddresses(config.chainId)
        this.provider = config.provider
        this.getSwapFeePercentage = config.getSwapFeePercentage
        this.dexTable = buildDexTable(this.addresses)
    }

    private async _finalizeExecutableQuote<
        TData extends SwapV2Struct | SwapV3Struct | SwapAeroV2Struct,
    >({
        finalization,
        adapter,
        path,
        amountToSend,
        amountQuoted,
        initialTollAmount,
        outputTollE3,
        slippage,
        buildSwap,
    }: {
        finalization?: PoolRouteFinalizationContext
        adapter: string
        path: V2Path | V3Path
        amountToSend: bigint
        amountQuoted: bigint
        initialTollAmount: bigint
        outputTollE3?: bigint
        slippage: bigint
        buildSwap: (amountToReceive: bigint) => {
            data: TData
            callData: BytesLike
        }
    }): Promise<{
        data: TData
        callData: BytesLike
        tollAmount: bigint
        effectiveSlippageBps?: string
    }> {
        if (!finalization) {
            const amountToReceive = withSlippageTolerance(
                amountQuoted,
                slippage
            )
            const tollAmount =
                initialTollAmount === 0n
                    ? (amountToReceive * (outputTollE3 ?? 200n)) /
                      PERCENT_DENOMINATOR
                    : initialTollAmount
            const swap = buildSwap(amountToReceive)
            return { ...swap, tollAmount }
        }

        const context: SwapSimulationContext = {
            chainId: this.chainId,
            blockNumber: finalization.blockNumber,
            controller: finalization.controller,
            vault: finalization.vault,
            adapter,
            account: finalization.account,
            path,
            buildCallDataForAmount: (amountToReceive) =>
                String(buildSwap(amountToReceive).callData),
            simulator: finalization.simulator,
            prefixTxs: finalization.prefixTxs,
        }

        const result = await finalizeRouteQuote({
            context,
            amountToSend,
            amountQuoted,
            initialTollAmount,
            outputTollE3,
            maxSlippageE3: finalization.maxSlippageE3 ?? slippage,
        })
        const { data } = buildSwap(result.finalAmountToReceive)

        return {
            data,
            callData: result.callData,
            tollAmount: result.finalTollAmount,
            effectiveSlippageBps: result.effectiveSlippageBps,
        }
    }

    public getDexData(exchangeFactory: string): DexData {
        const dex = this.dexTable[exchangeFactory.toLowerCase()]
        if (!dex) {
            throw new Error(
                `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: factory=${exchangeFactory} chainId=${this.chainId}`
            )
        }
        return dex
    }

    public isAerodrome(exchangeFactory: string): boolean {
        const dex = this.dexTable[exchangeFactory.toLowerCase()]
        return dex?.kind === 'aerodrome'
    }

    /**
     * Return the tier (fee / 0 for V2) of a specific pool address.
     * Verifies V2 pools by a live `getReserves()` call.
     */
    public async getPoolFeeTier(poolAddress: string): Promise<FeeTier> {
        try {
            const pool = connect<V3PoolLike>(
                poolAddress,
                V3_POOL_ABI,
                this.provider
            )
            const feeTier = await pool.fee()
            return Number(feeTier) as FeeTier
        } catch {
            try {
                const pair = connect<V2PairLike>(
                    poolAddress,
                    V2_PAIR_ABI,
                    this.provider
                )
                await pair.getReserves()
                return 0
            } catch {
                throw new Error(
                    `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: poolAddress=${poolAddress}`
                )
            }
        }
    }

    /**
     * Query all supported DEXes on-chain for `$TOKEN/$WETH` pools. Returns
     * every pool that exists with non-zero WETH balance, sorted descending by
     * `wethBalance` (deepest first). Callers that need a single best pick can
     * use `getUniswapCompatibleTokenPool`; callers that may need to fall back
     * (e.g. quoters that revert on a tightly-ranged pool) iterate the list.
     */
    private async _getPoolsFromOnChainQuery(
        token: string,
        options: { exchangeFactory?: string; swappableOnly?: boolean } = {}
    ): Promise<Pool[]> {
        const { exchangeFactory, swappableOnly } = options
        const weth = this.addresses.tokens.WETH
        const wethToken = new Token(weth, this.provider)

        const entries = Object.entries(this.dexTable).filter(
            ([factory, dex]) => {
                if (
                    exchangeFactory &&
                    !compareAddresses(exchangeFactory, factory)
                ) {
                    return false
                }
                if (swappableOnly && !dex.swappable) return false
                return true
            }
        )

        const pools: Pool[] = []

        await Promise.all(
            entries.map(async ([factoryAddress, dex]) => {
                if (dex.type === 'v2') {
                    try {
                        let pairAddress: string
                        if (dex.kind === 'aerodrome') {
                            const aeroFactory = connect<AeroFactoryLike>(
                                factoryAddress,
                                AERO_FACTORY_ABI,
                                this.provider
                            )
                            // Volatile pool (stable=false) — same call shape as
                            // the evm-side helper.
                            pairAddress = await aeroFactory.getPool(
                                token,
                                weth,
                                false
                            )
                        } else {
                            const factory = connect<V2FactoryLike>(
                                factoryAddress,
                                V2_FACTORY_ABI,
                                this.provider
                            )
                            pairAddress = await factory.getPair(token, weth)
                        }

                        if (pairAddress === ZeroAddress) return

                        const wethBalance =
                            await wethToken.balanceOf(pairAddress)
                        if (wethBalance === 0n) return

                        pools.push({
                            address: pairAddress,
                            feeTier: 0,
                            exchangeFactory: factoryAddress,
                            wethBalance,
                        })
                    } catch {
                        // No V2 pool on this factory — continue probing others.
                    }
                } else {
                    const factory = connect<V3FactoryLike>(
                        factoryAddress,
                        V3_FACTORY_ABI,
                        this.provider
                    )
                    await Promise.all(
                        dex.feeTiers.map(async (feeTier) => {
                            try {
                                const poolAddress = await factory.getPool(
                                    token,
                                    weth,
                                    feeTier
                                )
                                if (poolAddress === ZeroAddress) return
                                const wethBalance =
                                    await wethToken.balanceOf(poolAddress)
                                if (wethBalance === 0n) return

                                pools.push({
                                    address: poolAddress,
                                    feeTier: feeTier as FeeTier,
                                    exchangeFactory: factoryAddress,
                                    wethBalance,
                                })
                            } catch {
                                // ignore
                            }
                        })
                    )
                }
            })
        )

        pools.sort((a, b) => {
            if (a.wethBalance > b.wethBalance) return -1
            if (a.wethBalance < b.wethBalance) return 1
            return 0
        })

        return pools
    }

    /**
     * Get every $TOKEN/$WETH pool on the SDK's chain that has non-zero WETH
     * balance, sorted deepest-first. Cached for `CACHE_DURATION`.
     */
    public async getUniswapCompatibleTokenPools(
        token: string,
        options?: {
            type?: 'v2' | 'v3'
            exchangeFactory?: string
            swappableOnly?: boolean
        }
    ): Promise<Pool[]> {
        const swappableOnly = options?.swappableOnly ?? true
        const cacheKey = `onchain-${this.chainId}-${token.toLowerCase()}-${options?.exchangeFactory?.toLowerCase()}-${swappableOnly}`
        const hit = this.poolsCache[cacheKey]
        if (!hit || Date.now() - hit.timestamp > CACHE_DURATION) {
            this.poolsCache[cacheKey] = {
                timestamp: Date.now(),
                pools: await this._getPoolsFromOnChainQuery(token, {
                    exchangeFactory: options?.exchangeFactory,
                    swappableOnly,
                }),
            }
        }
        return this.poolsCache[cacheKey]!.pools
    }

    /**
     * Get the best (deepest-WETH) `$TOKEN/$WETH` pool on the SDK's chain,
     * optionally scoped to a specific exchangeFactory.
     *
     * `swappableOnly` (default true) restricts discovery to DEXes with a
     * deployed Guru Protocol adapter — required for swap routing. Set false for
     * pricing-only callers that should consider every on-chain pool.
     */
    public async getUniswapCompatibleTokenPool(
        token: string,
        options?: {
            type?: 'v2' | 'v3'
            exchangeFactory?: string
            swappableOnly?: boolean
        }
    ): Promise<Pool> {
        const pools = await this.getUniswapCompatibleTokenPools(token, options)
        if (pools.length === 0) {
            throw new Error(`${PoolHelperError.NO_ROUTE_FOUND}: token=${token}`)
        }
        return pools[0]!
    }

    /**
     * Quote the best swap for `[tokenIn, tokenOut]` across all supported DEXes.
     *
     * `requireSwappable` (default true) restricts pool selection to DEXes with
     * a deployed Guru Protocol adapter, so the picked pool can also be the destination
     * of `executeSwap`. Pricing-only callers that don't intend to encode the
     * route (e.g. `getPriceUsd1e18`) can pass false to widen pool discovery.
     */
    public async getBestQuote({
        swapType = SwapType.EXACT_INPUT,
        tokenAmount,
        slippage = 500n,
        path,
        requireSwappable = true,
    }: QuoteRequest): Promise<Quote> {
        const weth = this.addresses.tokens.WETH
        if (!path.some((t) => compareAddresses(t, weth))) {
            throw new Error(
                `${PoolHelperError.NO_ROUTE_FOUND}: WETH not in path`
            )
        }

        const token = path.find((t) => !compareAddresses(t, weth))!
        const pools = await this.getUniswapCompatibleTokenPools(token, {
            swappableOnly: requireSwappable,
        })
        if (pools.length === 0) {
            throw new Error(`${PoolHelperError.NO_ROUTE_FOUND}: token=${token}`)
        }

        // Iterate pools deepest-first; some pools (e.g. tightly-ranged V3
        // positions out of swap range) hold WETH but revert on the quoter.
        // Skip those and try the next-deepest until one prices the trade.
        let lastError: unknown
        for (const pool of pools) {
            const isV2Pool = pool.feeTier === 0
            const getQuote = isV2Pool ? this.getV2Quote : this.getV3Quote
            try {
                return await getQuote.call(this, {
                    swapType,
                    tokenAmount,
                    path,
                    slippage,
                    exchangeFactory: pool.exchangeFactory,
                    feeTier: pool.feeTier,
                    poolAddress: pool.address,
                })
            } catch (err) {
                lastError = err
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(`${PoolHelperError.NO_ROUTE_FOUND}: token=${token}`)
    }

    public async getV2Quote({
        swapType = SwapType.EXACT_INPUT,
        tokenAmount,
        exchangeFactory,
        path,
        feeTier,
        slippage,
    }: VersionSpecificQuoteRequest): Promise<Quote> {
        const dex = this.getDexData(exchangeFactory)
        if (dex.type !== 'v2') {
            throw new Error(
                `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: factory=${exchangeFactory}`
            )
        }

        const swapFeePercentage = await this.getSwapFeePercentage()

        const { adjustedTokenAmount, swapFee: swapFeeFromInputAdjustment } =
            this._adjustTokenAmountForSwapFee(
                tokenAmount,
                swapFeePercentage,
                swapType,
                path
            )

        const getAmounts = (): Promise<bigint[]> => {
            if (dex.kind === 'aerodrome') {
                const v2Router = connect<AeroV2RouterLike>(
                    dex.router,
                    AERO_V2_ROUTER_ABI,
                    this.provider
                )
                const _path =
                    swapType === SwapType.EXACT_INPUT
                        ? path
                        : ([...path].reverse() as [string, string])
                const routes: AeroRoute[] = [
                    {
                        from: _path[0],
                        to: _path[1],
                        stable: false,
                        factory: exchangeFactory,
                    },
                ]
                return v2Router.getAmountsOut(adjustedTokenAmount, routes)
            }

            const v2Router = connect<V2RouterLike>(
                dex.router,
                V2_ROUTER_ABI,
                this.provider
            )
            return swapType === SwapType.EXACT_INPUT
                ? v2Router.getAmountsOut(adjustedTokenAmount, path)
                : v2Router.getAmountsIn(adjustedTokenAmount, path)
        }

        const amounts = await getAmounts()
        const quotedInput = amounts[0]
        if (quotedInput == null) {
            throw new Error(
                `${PoolHelperError.NO_ROUTE_FOUND}: empty quote (${exchangeFactory})`
            )
        }
        const quotedOutput = lastAmount(amounts, exchangeFactory)

        const { adjustedQuote, swapFee: swapFeeFromQuoteAdjustment } =
            this._adjustQuoteForSwapFeeAndSlippage(
                swapType === SwapType.EXACT_INPUT ? quotedOutput : quotedInput,
                swapFeePercentage,
                slippage,
                swapType,
                path
            )

        return {
            amount: adjustedQuote,
            feeTier,
            swapFee: swapFeeFromInputAdjustment + swapFeeFromQuoteAdjustment,
            router: dex.router,
            exchangeFactory,
        }
    }

    public async getV3Quote({
        swapType = SwapType.EXACT_INPUT,
        tokenAmount,
        exchangeFactory,
        path,
        feeTier,
        slippage,
        poolAddress,
    }: VersionSpecificQuoteRequest): Promise<Quote> {
        const [$INPUT, $OUTPUT] = path

        const dex = this.getDexData(exchangeFactory)
        if (dex.type !== 'v3') {
            throw new Error(
                `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: factory=${exchangeFactory}`
            )
        }

        const swapFeePercentage = await this.getSwapFeePercentage()
        const { adjustedTokenAmount, swapFee: swapFeeFromInputAdjustment } =
            this._adjustTokenAmountForSwapFee(
                tokenAmount,
                swapFeePercentage,
                swapType,
                path
            )

        let tickSpacing: bigint | undefined
        let getQuote: () => Promise<bigint>

        if (dex.kind === 'aerodrome') {
            if (!poolAddress) {
                throw new Error(
                    `${PoolHelperError.NO_POOL_ADDRESS}: factory=${exchangeFactory}`
                )
            }
            const poolContract = connect<V3PoolTickSpacingLike>(
                poolAddress,
                V3_POOL_TICKSPACING_ABI,
                this.provider
            )
            const _tickSpacing = await poolContract.tickSpacing()
            tickSpacing = _tickSpacing

            const aerodromeQuoter = connect<AeroV3QuoterLike>(
                dex.quoter,
                AERO_V3_QUOTER_ABI,
                this.provider
            )

            if (swapType === SwapType.EXACT_INPUT) {
                getQuote = async () => {
                    const result =
                        await aerodromeQuoter.quoteExactInputSingle.staticCall({
                            tokenIn: $INPUT!,
                            tokenOut: $OUTPUT!,
                            amountIn: adjustedTokenAmount,
                            sqrtPriceLimitX96: 0n,
                            tickSpacing: _tickSpacing,
                        })
                    return result.amountOut
                }
            } else {
                getQuote = async () => {
                    const result =
                        await aerodromeQuoter.quoteExactOutputSingle.staticCall(
                            {
                                tokenIn: $INPUT!,
                                tokenOut: $OUTPUT!,
                                amount: adjustedTokenAmount,
                                sqrtPriceLimitX96: 0n,
                                tickSpacing: _tickSpacing,
                            }
                        )
                    return result.amountIn
                }
            }
        } else {
            const v3Quoter = IPancakeQuoterV2__factory.connect(
                dex.quoter,
                this.provider
            )
            const quoteRequest = {
                tokenIn: $INPUT!,
                tokenOut: $OUTPUT!,
                fee: BigInt(feeTier),
                sqrtPriceLimitX96: 0n,
            }
            if (swapType === SwapType.EXACT_INPUT) {
                getQuote = async () => {
                    const [amountOut] =
                        await v3Quoter.quoteExactInputSingle.staticCall({
                            ...quoteRequest,
                            amountIn: adjustedTokenAmount,
                        })
                    return amountOut
                }
            } else {
                getQuote = async () => {
                    const [amountIn] =
                        await v3Quoter.quoteExactOutputSingle.staticCall({
                            ...quoteRequest,
                            amount: adjustedTokenAmount,
                        })
                    return amountIn
                }
            }
        }

        const quote = await getQuote()

        const { adjustedQuote, swapFee: swapFeeFromQuoteAdjustment } =
            this._adjustQuoteForSwapFeeAndSlippage(
                quote,
                swapFeePercentage,
                slippage,
                swapType,
                path
            )

        return {
            amount: adjustedQuote,
            feeTier,
            swapFee: swapFeeFromInputAdjustment + swapFeeFromQuoteAdjustment,
            router: dex.router ?? dex.quoter,
            exchangeFactory,
            poolAddress,
            tickSpacing,
        }
    }

    /**
     * @param path `[stable, WETH, token]`
     * @returns adapter, encoded swap, and the toll taken on the input.
     */
    public async getStableForTokenQuote({
        path,
        inputAmount,
        slippage = 500n,
        exchangeFactory,
        finalization,
    }: StableQuoteRequest): Promise<StableQuoteResult> {
        const adapter = this.getLotusAdapter(exchangeFactory)
        const dexData = this.getDexData(exchangeFactory)
        const swapFeePercentage = await this.getSwapFeePercentage()

        const swapFee = (inputAmount * swapFeePercentage) / PERCENT_DENOMINATOR
        const adjustedInputAmount = inputAmount - swapFee

        if (dexData.type === 'v2') {
            const deadline = Math.floor((Date.now() + 1000 * 60 * 5) / 1000)

            if (dexData.kind === 'aerodrome') {
                const v2Router = connect<AeroV2RouterLike>(
                    dexData.router,
                    AERO_V2_ROUTER_ABI,
                    this.provider
                )
                const routes = buildAerodromeV2Routes(path, exchangeFactory)
                const amounts = await v2Router.getAmountsOut(
                    adjustedInputAmount,
                    routes
                )

                const finalized = await this._finalizeExecutableQuote({
                    finalization,
                    adapter,
                    path,
                    amountToSend: inputAmount,
                    amountQuoted: lastAmount(amounts, exchangeFactory),
                    initialTollAmount: swapFee,
                    slippage,
                    buildSwap: (amountToReceive) => {
                        const data: SwapAeroV2Struct = {
                            amountToSend: inputAmount,
                            amountToReceive,
                            routes,
                            deadline,
                        }
                        return {
                            data,
                            callData:
                                AerodromeV2Adapter__factory.createInterface().encodeFunctionData(
                                    'executeSwap',
                                    [data]
                                ),
                        }
                    },
                })

                return {
                    adapter,
                    data: finalized.data,
                    callData: finalized.callData,
                    toll: { currency: path[0], amount: finalized.tollAmount },
                    effectiveSlippageBps: finalized.effectiveSlippageBps,
                }
            }

            const v2Router = connect<V2RouterLike>(
                dexData.router,
                V2_ROUTER_ABI,
                this.provider
            )
            const amounts = await v2Router.getAmountsOut(
                adjustedInputAmount,
                path
            )

            const finalized = await this._finalizeExecutableQuote({
                finalization,
                adapter,
                path,
                amountToSend: inputAmount,
                amountQuoted: lastAmount(amounts, exchangeFactory),
                initialTollAmount: swapFee,
                slippage,
                buildSwap: (amountToReceive) => {
                    const data: SwapV2Struct = {
                        amountToSend: inputAmount,
                        amountToReceive,
                        path,
                        deadline,
                    }
                    return {
                        data,
                        callData:
                            UniswapV2Adapter__factory.createInterface().encodeFunctionData(
                                'executeSwap',
                                [data]
                            ),
                    }
                },
            })

            return {
                adapter,
                data: finalized.data,
                callData: finalized.callData,
                toll: { currency: path[0], amount: finalized.tollAmount },
                effectiveSlippageBps: finalized.effectiveSlippageBps,
            }
        }

        // v3
        const quoter:
            | AeroV3QuoterLike
            | ReturnType<typeof IPancakeQuoterV2__factory.connect> =
            dexData.kind === 'aerodrome'
                ? connect<AeroV3QuoterLike>(
                      dexData.quoter,
                      AERO_V3_QUOTER_ABI,
                      this.provider
                  )
                : IPancakeQuoterV2__factory.connect(
                      dexData.quoter,
                      this.provider
                  )

        const [stable, intermediate, token] = path
        if (!token) {
            throw new Error(
                `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: direct V3 fallback not supported (factory=${exchangeFactory})`
            )
        }

        const { feeTier: stableFeeTier } =
            await this.getUniswapCompatibleTokenPool(path[0], {
                exchangeFactory,
            })
        const { feeTier: tokenFeeTier } =
            await this.getUniswapCompatibleTokenPool(token, {
                exchangeFactory,
            })

        const pathBytes: BytesLike = solidityPacked(
            ['address', 'uint24', 'address', 'uint24', 'address'],
            [stable, stableFeeTier, intermediate, tokenFeeTier, token]
        )

        // Aerodrome's V3 quoter does not implement `quoteExactInput(bytes)`.
        // Fall back to IPancakeQuoterV2's multi-hop method for the non-Aero
        // branch; the Aero branch should not hit this combined-path flow since
        // its CL quoter signature differs.
        if (dexData.kind === 'aerodrome') {
            throw new Error(
                `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: Aerodrome V3 multi-hop not supported (factory=${exchangeFactory})`
            )
        }

        const univ3Quoter = quoter as ReturnType<
            typeof IPancakeQuoterV2__factory.connect
        >
        const amountOut = await this._quoteV3MultiHop(
            univ3Quoter,
            adjustedInputAmount,
            pathBytes,
            [
                { tokenIn: stable, tokenOut: intermediate, fee: stableFeeTier },
                { tokenIn: intermediate, tokenOut: token, fee: tokenFeeTier },
            ]
        )

        const deadline = Math.floor((Date.now() + 1000 * 60 * 5) / 1000)
        const finalized = await this._finalizeExecutableQuote({
            finalization,
            adapter,
            path: [
                {
                    tokenIn: stable,
                    tokenOut: intermediate,
                    fee: String(stableFeeTier),
                },
                {
                    tokenIn: intermediate,
                    tokenOut: token,
                    fee: String(tokenFeeTier),
                },
            ],
            amountToSend: inputAmount,
            amountQuoted: amountOut,
            initialTollAmount: swapFee,
            slippage,
            buildSwap: (amountToReceive) => {
                const data: SwapV3Struct = {
                    amountToSend: inputAmount,
                    amountToReceive,
                    path: pathBytes,
                    deadline,
                }
                return {
                    data,
                    callData:
                        UniswapV3Adapter__factory.createInterface().encodeFunctionData(
                            'executeSwap',
                            [data]
                        ),
                }
            },
        })

        return {
            adapter,
            data: finalized.data,
            callData: finalized.callData,
            toll: { currency: path[0], amount: finalized.tollAmount },
            effectiveSlippageBps: finalized.effectiveSlippageBps,
        }
    }

    /**
     * Quote a Uniswap-V3-compatible 2-hop swap. Tries `quoteExactInput(bytes)`
     * first; falls back to two `quoteExactInputSingle` calls chained together
     * if the multi-hop quoter reverts. The Uniswap V3 QuoterV2 is known to
     * revert on multi-hop quotes that cross initialised ticks, even when each
     * pool individually has plenty of liquidity. The actual SwapRouter
     * `exactInput` handles the same path fine — only the quoter is fragile.
     */
    private async _quoteV3MultiHop(
        quoter: ReturnType<typeof IPancakeQuoterV2__factory.connect>,
        amountIn: bigint,
        pathBytes: BytesLike,
        legs: { tokenIn: string; tokenOut: string; fee: FeeTier }[]
    ): Promise<bigint> {
        try {
            const r = await quoter.quoteExactInput.staticCall(
                pathBytes,
                amountIn
            )
            return r.amountOut
        } catch {
            // Walk the legs serially, feeding each leg's amountOut into the
            // next as amountIn.
            let amount = amountIn
            for (const leg of legs) {
                const [out] = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn: leg.tokenIn,
                    tokenOut: leg.tokenOut,
                    fee: BigInt(leg.fee),
                    amountIn: amount,
                    sqrtPriceLimitX96: 0n,
                })
                amount = out
            }
            return amount
        }
    }

    /**
     * @param path `[token, WETH, stable]`
     */
    public async getTokensForStableQuote({
        path,
        inputAmount,
        slippage = 500n,
        exchangeFactory,
        finalization,
    }: StableQuoteRequest): Promise<StableQuoteResult> {
        const adapter = this.getLotusAdapter(exchangeFactory)
        const dexData = this.getDexData(exchangeFactory)
        const swapFeePercentage = await this.getSwapFeePercentage()

        if (dexData.type === 'v2') {
            const deadline = Math.floor((Date.now() + 1000 * 60 * 5) / 1000)

            if (dexData.kind === 'aerodrome') {
                const v2Router = connect<AeroV2RouterLike>(
                    dexData.router,
                    AERO_V2_ROUTER_ABI,
                    this.provider
                )
                const routes = buildAerodromeV2Routes(path, exchangeFactory)
                const amounts = await v2Router.getAmountsOut(
                    inputAmount,
                    routes
                )

                const grossAmountOut = lastAmount(amounts, exchangeFactory)
                const netAmountOut =
                    grossAmountOut -
                    (grossAmountOut * swapFeePercentage) / PERCENT_DENOMINATOR
                const finalized = await this._finalizeExecutableQuote({
                    finalization,
                    adapter,
                    path,
                    amountToSend: inputAmount,
                    amountQuoted: netAmountOut,
                    initialTollAmount: 0n,
                    outputTollE3: swapFeePercentage,
                    slippage,
                    buildSwap: (amountToReceive) => {
                        const data: SwapAeroV2Struct = {
                            amountToSend: inputAmount,
                            amountToReceive,
                            routes,
                            deadline,
                        }
                        return {
                            data,
                            callData:
                                AerodromeV2Adapter__factory.createInterface().encodeFunctionData(
                                    'executeSwap',
                                    [data]
                                ),
                        }
                    },
                })

                return {
                    adapter,
                    data: finalized.data,
                    callData: finalized.callData,
                    toll: {
                        currency: path[path.length - 1]!,
                        amount: finalized.tollAmount,
                    },
                    effectiveSlippageBps: finalized.effectiveSlippageBps,
                }
            }

            const v2Router = connect<V2RouterLike>(
                dexData.router,
                V2_ROUTER_ABI,
                this.provider
            )
            const amounts = await v2Router.getAmountsOut(inputAmount, path)

            const grossAmountOut = lastAmount(amounts, exchangeFactory)
            const netAmountOut =
                grossAmountOut -
                (grossAmountOut * swapFeePercentage) / PERCENT_DENOMINATOR
            const finalized = await this._finalizeExecutableQuote({
                finalization,
                adapter,
                path,
                amountToSend: inputAmount,
                amountQuoted: netAmountOut,
                initialTollAmount: 0n,
                outputTollE3: swapFeePercentage,
                slippage,
                buildSwap: (amountToReceive) => {
                    const data: SwapV2Struct = {
                        amountToSend: inputAmount,
                        amountToReceive,
                        path,
                        deadline,
                    }
                    return {
                        data,
                        callData:
                            UniswapV2Adapter__factory.createInterface().encodeFunctionData(
                                'executeSwap',
                                [data]
                            ),
                    }
                },
            })

            return {
                adapter,
                data: finalized.data,
                callData: finalized.callData,
                toll: {
                    currency: path[path.length - 1]!,
                    amount: finalized.tollAmount,
                },
                effectiveSlippageBps: finalized.effectiveSlippageBps,
            }
        }

        // v3
        if (dexData.kind === 'aerodrome') {
            throw new Error(
                `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: Aerodrome V3 multi-hop not supported (factory=${exchangeFactory})`
            )
        }

        const v3Quoter = IPancakeQuoterV2__factory.connect(
            dexData.quoter,
            this.provider
        )

        const [token, intermediate, stable] = path
        if (!stable) {
            throw new Error(
                `${PoolHelperError.EXCHANGE_INCOMPATIBLE}: direct V3 fallback not supported (factory=${exchangeFactory})`
            )
        }

        const { feeTier: tokenFeeTier } =
            await this.getUniswapCompatibleTokenPool(path[0], {
                exchangeFactory,
            })
        const { feeTier: stableFeeTier } =
            await this.getUniswapCompatibleTokenPool(stable, {
                exchangeFactory,
            })

        const pathBytes = solidityPacked(
            ['address', 'uint24', 'address', 'uint24', 'address'],
            [token, tokenFeeTier, intermediate, stableFeeTier, stable]
        )

        const amountOut = await this._quoteV3MultiHop(
            v3Quoter,
            inputAmount,
            pathBytes,
            [
                { tokenIn: token, tokenOut: intermediate, fee: tokenFeeTier },
                { tokenIn: intermediate, tokenOut: stable, fee: stableFeeTier },
            ]
        )

        const deadline = Math.floor((Date.now() + 1000 * 60 * 5) / 1000)
        const netAmountOut =
            amountOut - (amountOut * swapFeePercentage) / PERCENT_DENOMINATOR
        const finalized = await this._finalizeExecutableQuote({
            finalization,
            adapter,
            path: [
                {
                    tokenIn: token,
                    tokenOut: intermediate,
                    fee: String(tokenFeeTier),
                },
                {
                    tokenIn: intermediate,
                    tokenOut: stable,
                    fee: String(stableFeeTier),
                },
            ],
            amountToSend: inputAmount,
            amountQuoted: netAmountOut,
            initialTollAmount: 0n,
            outputTollE3: swapFeePercentage,
            slippage,
            buildSwap: (amountToReceive) => {
                const data: SwapV3Struct = {
                    amountToSend: inputAmount,
                    amountToReceive,
                    path: pathBytes,
                    deadline,
                }
                return {
                    data,
                    callData:
                        UniswapV3Adapter__factory.createInterface().encodeFunctionData(
                            'executeSwap',
                            [data]
                        ),
                }
            },
        })

        return {
            adapter,
            data: finalized.data,
            callData: finalized.callData,
            toll: { currency: stable, amount: finalized.tollAmount },
            effectiveSlippageBps: finalized.effectiveSlippageBps,
        }
    }

    public getLotusAdapter(exchangeFactory: string): string {
        const factoryLower = exchangeFactory.toLowerCase()
        const f = this.addresses.factories
        const a = this.addresses.adapters

        const adapter = (
            [
                [f.uniswapV2, a.uniswapV2],
                [f.uniswapV3, a.uniswapV3],
                [f.pancakeV2, a.pancakeV2],
                [f.pancakeV3, a.pancakeV3],
                [f.aerodromeV2, a.aerodromeV2],
                [f.aerodromeV3, a.aerodromeV3],
                [f.aerodromeV3Bis, a.aerodromeV3],
            ] as const
        ).find(
            ([factory]) => factory && factory.toLowerCase() === factoryLower
        )?.[1]

        if (!adapter) {
            throw new Error(
                `${PoolHelperError.LOTUS_ADAPTER_MISSING}: factory=${exchangeFactory} chainId=${this.chainId}`
            )
        }
        return adapter
    }

    private _adjustTokenAmountForSwapFee(
        tokenAmount: bigint,
        swapFeePercentage: bigint,
        swapType: SwapType,
        path: [string, string]
    ): { adjustedTokenAmount: bigint; swapFee: bigint } {
        const weth = this.addresses.tokens.WETH
        const shouldAdjust = compareAddresses(path[Number(swapType)]!, weth)
        if (!shouldAdjust) {
            return { adjustedTokenAmount: tokenAmount, swapFee: 0n }
        }
        const swapFee = (tokenAmount * swapFeePercentage) / PERCENT_DENOMINATOR
        const adjustedTokenAmount =
            swapType === SwapType.EXACT_INPUT
                ? tokenAmount - swapFee
                : tokenAmount + swapFee
        return { adjustedTokenAmount, swapFee }
    }

    private _adjustQuoteForSwapFeeAndSlippage(
        quote: bigint,
        swapFeePercentage: bigint,
        slippage: bigint,
        swapType: SwapType,
        path: [string, string]
    ): { adjustedQuote: bigint; swapFee: bigint } {
        const weth = this.addresses.tokens.WETH
        const sign = swapType === SwapType.EXACT_INPUT ? -1n : 1n
        const slippageTolerance = calcSlippageTolerance(quote, slippage) * sign
        const quoteWithSlippage = quote + slippageTolerance

        const shouldAdjustQuote = !compareAddresses(
            path[Number(swapType)]!,
            weth
        )
        if (!shouldAdjustQuote) {
            return { adjustedQuote: quoteWithSlippage, swapFee: 0n }
        }

        const swapFee = (quote * swapFeePercentage) / PERCENT_DENOMINATOR
        const adjustedQuote =
            swapType === SwapType.EXACT_INPUT
                ? quoteWithSlippage - swapFee
                : quoteWithSlippage + swapFee

        return { adjustedQuote, swapFee }
    }
}
