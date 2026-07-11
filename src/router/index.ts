import { Contract, parseEther, ZeroAddress, type Provider } from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolAddresses,
    type GuruProtocolChainId,
} from '../addresses'
import compareAddresses from '../helpers/compareAddresses'
import { Token } from '../helpers/Token'
import {
    getFallbackRouteIn,
    getFallbackRouteOut,
    type GetFallbackRouteContext,
} from './getFallbackRoutes'
import getUniswapV4Route, {
    connectV4Quoter,
    toAdapterPathKeys,
    type GetUniswapV4RouteContext,
} from './getUniswapV4Route'
import getVeloraRoute, { type GetVeloraRouteContext } from './getVeloraRoute'
import { stablecoinAddresses } from './helpers'
import type { PathFetcher } from './pathCache'
import PoolHelper from './poolHelper'
import type { SwapSimulator } from './simulation'
import type { Route, RouteSearchParams } from './types'
import { discoverV4Paths } from './v4PoolDiscovery'

const AERO_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)',
] as const

const V2_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) view returns (address pair)',
] as const

const V2_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)',
] as const

const AERO_V2_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
] as const

const AERO_V2_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
] as const

const V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
] as const

const V3_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
] as const

const AERO_V3_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
] as const

const UNISWAP_V3_FEES = [100, 500, 3000, 10000] as const
const PANCAKE_V3_FEES = [100, 500, 2500, 10000] as const
const AERODROME_V3_TICK_SPACINGS = [1, 50, 100, 200] as const

interface V2FactoryLike {
    getPair: (tokenA: string, tokenB: string) => Promise<string>
}

interface V2RouterLike {
    getAmountsOut: (amountIn: bigint, path: string[]) => Promise<bigint[]>
}

interface AeroV2FactoryLike {
    getPool: (
        tokenA: string,
        tokenB: string,
        stable: boolean
    ) => Promise<string>
}

type AeroV2Route = {
    from: string
    to: string
    stable: boolean
    factory: string
}

interface AeroV2RouterLike {
    getAmountsOut: (
        amountIn: bigint,
        routes: AeroV2Route[]
    ) => Promise<bigint[]>
}

interface V3FactoryLike {
    getPool: (tokenA: string, tokenB: string, fee: number) => Promise<string>
}

interface V3QuoterLike {
    quoteExactInputSingle: {
        staticCall: (params: {
            tokenIn: string
            tokenOut: string
            amountIn: bigint
            fee: bigint
            sqrtPriceLimitX96: bigint
        }) => Promise<{ amountOut: bigint }>
    }
}

interface AeroV3FactoryLike {
    getPool: (
        tokenA: string,
        tokenB: string,
        tickSpacing: number
    ) => Promise<string>
}

interface AeroV3QuoterLike {
    quoteExactInputSingle: {
        staticCall: (params: {
            tokenIn: string
            tokenOut: string
            amountIn: bigint
            tickSpacing: bigint
            sqrtPriceLimitX96: bigint
        }) => Promise<{ amountOut: bigint }>
    }
}

/**
 * Orchestration context for `getRouteIn`/`getRouteOut`. Combines the Velora
 * primary path's needs (provider + simulator for on-chain quote sims) and the
 * PoolHelper fallback path's needs (provider + swap-fee accessor).
 */
export interface RouterContext {
    provider: Provider
    simulator: SwapSimulator
    getSwapFeePercentage: () => Promise<bigint>
    getPath: PathFetcher
}

/**
 * Primary route resolution: Velora first (covers V2/V3/Pancake and hookless
 * V4 via the version-6.2 engine); only when it yields nothing, fall through
 * to Dexscreener-discovered direct V4 pools (hooked pools are invisible to
 * aggregators). Ordinary quotes therefore never pay for V4 discovery.
 *
 * Exported as an SDK-internal seam exercised directly in unit tests.
 */
export async function veloraThenV4Discovery(
    velora: () => Promise<Route>,
    v4Discovery: () => Promise<Route>
): Promise<Route> {
    try {
        return await velora()
    } catch {
        return await v4Discovery()
    }
}

/**
 * Compare discovery-only V4 against the ordinary on-chain fallback and return
 * the economically better executable route. Both route families expose a
 * net `amountToReceive`, so this comparison is like-for-like for exact-input
 * trades. A successful V4 simulation alone is not evidence that its price is
 * competitive.
 */
export async function bestOfV4AndFallback(
    v4Discovery: () => Promise<Route>,
    fallback: () => Promise<Route>
): Promise<Route> {
    const [v4Result, fallbackResult] = await Promise.allSettled([
        v4Discovery(),
        fallback(),
    ])

    if (
        v4Result.status === 'rejected' &&
        v4Result.reason instanceof Error &&
        (v4Result.reason.message.includes('TOKEN_LOCKED_BY_V4_HOOK') ||
            v4Result.reason.message.includes('UNISWAP_V4_HOOK_ROUTE_REVERTED'))
    ) {
        throw v4Result.reason
    }

    if (v4Result.status === 'fulfilled' && fallbackResult.status === 'fulfilled') {
        return BigInt(v4Result.value.data.amountToReceive) >=
            BigInt(fallbackResult.value.data.amountToReceive)
            ? v4Result.value
            : fallbackResult.value
    }
    if (v4Result.status === 'fulfilled') return v4Result.value
    if (fallbackResult.status === 'fulfilled') return fallbackResult.value

    throw fallbackResult.reason
}

/**
 * Returns the result of `velora()` if it resolves, otherwise the result of
 * `fallback()`. Mirrors the original `apps/trpc/src/services/get-route` shape:
 * a single try/catch with a console.error on the velora failure path.
 *
 * Exported as the SDK-internal seam used by `getRouteIn`/`getRouteOut` and
 * exercised directly in unit tests so we don't need to stub fetch+RPC chains.
 */
export async function tryWithVeloraFallback<T>(
    velora: () => Promise<T>,
    fallback: () => Promise<T>
): Promise<T> {
    try {
        return await velora()
    } catch (err) {
        if (
            err instanceof Error &&
            (err.message.includes('TOKEN_LOCKED_BY_V4_HOOK') ||
                err.message.includes('UNISWAP_V4_HOOK_ROUTE_REVERTED'))
        ) {
            throw err
        }
        console.error(
            '[@guru-fund/sdk] Velora route failed, retrying via fallback:',
            err
        )
        return await fallback()
    }
}

export async function getRouteIn(
    params: RouteSearchParams,
    ctx: RouterContext
): Promise<Route> {
    const veloraCtx: GetVeloraRouteContext = {
        provider: ctx.provider,
        simulator: ctx.simulator,
        getPath: ctx.getPath,
    }
    const v4Ctx: GetUniswapV4RouteContext = {
        provider: ctx.provider,
        simulator: ctx.simulator,
    }
    const fallbackCtx: GetFallbackRouteContext = {
        provider: ctx.provider,
        simulator: ctx.simulator,
        getSwapFeePercentage: ctx.getSwapFeePercentage,
    }
    try {
        return await getVeloraRoute(params, veloraCtx)
    } catch {
        return bestOfV4AndFallback(
            () => getUniswapV4Route(params, v4Ctx),
            () => getFallbackRouteIn(params, fallbackCtx)
        )
    }
}

export async function getRouteOut(
    params: RouteSearchParams,
    ctx: RouterContext
): Promise<Route> {
    const veloraCtx: GetVeloraRouteContext = {
        provider: ctx.provider,
        simulator: ctx.simulator,
        getPath: ctx.getPath,
    }
    const v4Ctx: GetUniswapV4RouteContext = {
        provider: ctx.provider,
        simulator: ctx.simulator,
    }
    const fallbackCtx: GetFallbackRouteContext = {
        provider: ctx.provider,
        simulator: ctx.simulator,
        getSwapFeePercentage: ctx.getSwapFeePercentage,
    }
    try {
        return await getVeloraRoute(params, veloraCtx)
    } catch {
        return bestOfV4AndFallback(
            () => getUniswapV4Route(params, v4Ctx),
            () => getFallbackRouteOut(params, fallbackCtx)
        )
    }
}

/**
 * Returns the on-chain USD price of `token` as a 1e18-scaled bigint.
 *
 * Strategy mirrors the legacy `EvmPriceFetcher`:
 *   1. Quote 1 WETH → USDC via PoolHelper (best DEX wins) → wethUsd
 *   2. If `token` is WETH, return wethUsd directly.
 *   3. Otherwise quote 1 token → WETH and convert: tokenUsd = oneTokenInWeth * wethUsd / WETH.unit
 *
 * The "fallback" promised by the SDK boundary lives inside PoolHelper itself:
 * `getBestQuote` scans every supported DEX (Uniswap/Pancake on mainnet,
 * Aerodrome/Pancake on base) and returns the deepest pool. This keeps the
 * price source single-stack on-chain, and avoids dragging Coingecko/Relay
 * fetchers across the SDK boundary.
 */
export async function getPriceUsd1e18(
    token: string,
    ctx: {
        chainId: GuruProtocolChainId
        provider: Provider
        getSwapFeePercentage: () => Promise<bigint>
    }
): Promise<bigint> {
    const addresses: GuruProtocolAddresses = getGuruProtocolAddresses(
        ctx.chainId
    )

    if (
        stablecoinAddresses(addresses).some((stable) =>
            compareAddresses(token, stable)
        )
    ) {
        return 10n ** 18n
    }

    const poolHelper = new PoolHelper({
        chainId: ctx.chainId,
        provider: ctx.provider,
        getSwapFeePercentage: ctx.getSwapFeePercentage,
    })

    // Pricing scans every DEX with on-chain liquidity, including those without
    // a Guru Protocol adapter — we only need a price, not a swap route.
    const stable = addresses.tokens.USDG ?? addresses.tokens.USDC
    const { decimals: stableDecimals } = await new Token(stable, ctx.provider)
        .metadata()
        .catch(() => ({ decimals: 6 }))
    const stableUnit = Token.unitFor(stableDecimals)
    const stableAmountToUsd1e18 = (amount: bigint): bigint =>
        (amount * 10n ** 18n) / stableUnit

    let wethUsdCache: bigint | undefined
    const getWethUsd = async (): Promise<bigint> => {
        if (wethUsdCache != null) return wethUsdCache
        const { amount: wethStable } = await poolHelper.getBestQuote({
            tokenAmount: parseEther('1'),
            path: [addresses.tokens.WETH, stable],
            requireSwappable: false,
        })
        wethUsdCache = stableAmountToUsd1e18(wethStable)
        return wethUsdCache
    }

    if (compareAddresses(token, addresses.tokens.WETH)) {
        return getWethUsd()
    }

    const { decimals } = await new Token(token, ctx.provider).metadata()
    const oneToken = 10n ** BigInt(decimals)

    const stableUsd = await _priceViaDirectStablePool(
        token,
        oneToken,
        poolHelper,
        stable,
        stableDecimals,
        ctx.provider
    )

    const WETH_UNIT = 10n ** 18n

    try {
        const wethUsd = await getWethUsd()
        const { amount: oneTokenInWeth } = await poolHelper.getBestQuote({
            tokenAmount: oneToken,
            path: [token, addresses.tokens.WETH],
            requireSwappable: false,
        })
        const wethRouteUsd = (oneTokenInWeth * wethUsd) / WETH_UNIT
        return stableUsd !== null && stableUsd > wethRouteUsd
            ? stableUsd
            : wethRouteUsd
    } catch (error) {
        // V2/V3-less tokens (V4-only, e.g. hooked-pool launches) are invisible
        // to PoolHelper's factory scan — fall back to discovered V4 pools.
        const v4Usd = await _priceViaV4Pools(token, oneToken, getWethUsd, ctx)
        if (stableUsd !== null && v4Usd !== null) {
            return stableUsd > v4Usd ? stableUsd : v4Usd
        }
        if (stableUsd !== null) return stableUsd
        if (v4Usd !== null) return v4Usd
        throw error
    }
}

async function _priceViaDirectStablePool(
    token: string,
    oneToken: bigint,
    poolHelper: PoolHelper,
    stable: string,
    stableDecimals: number,
    provider: Provider
): Promise<bigint | null> {
    const stableUnit = Token.unitFor(stableDecimals)
    const toUsd1e18 = (amount: bigint): bigint =>
        (amount * 10n ** 18n) / stableUnit

    const quotes: bigint[] = []

    const v2Amount = await _quoteDirectV2StablePools(
        token,
        stable,
        oneToken,
        poolHelper,
        provider
    )
    if (v2Amount > 0n) quotes.push(v2Amount)

    const v3Amount = await _quoteDirectV3StablePools(
        token,
        stable,
        oneToken,
        poolHelper,
        provider
    )
    if (v3Amount > 0n) quotes.push(v3Amount)

    const aeroV3Amount = await _quoteDirectAerodromeV3StablePool(
        token,
        stable,
        oneToken,
        poolHelper,
        provider
    )
    if (aeroV3Amount > 0n) quotes.push(aeroV3Amount)

    if (quotes.length === 0) return null

    const best = quotes.reduce((currentBest, amount) =>
        amount > currentBest ? amount : currentBest
    )
    return toUsd1e18(best)
}

async function _quoteDirectV2StablePools(
    token: string,
    stable: string,
    oneToken: bigint,
    poolHelper: PoolHelper,
    provider: Provider
): Promise<bigint> {
    let best = 0n

    const quoteStandardV2 = async (
        factoryAddress: string | undefined,
        routerAddress: string | undefined
    ) => {
        if (!factoryAddress || !routerAddress) return
        const factory = new Contract(
            factoryAddress,
            V2_FACTORY_ABI,
            provider
        ) as unknown as V2FactoryLike
        const pairAddress = await factory
            .getPair(token, stable)
            .catch(() => ZeroAddress)
        if (pairAddress === ZeroAddress) return

        const router = new Contract(
            routerAddress,
            V2_ROUTER_ABI,
            provider
        ) as unknown as V2RouterLike
        const amounts = await router
            .getAmountsOut(oneToken, [token, stable])
            .catch(() => null)
        const amountOut = amounts?.at(-1) ?? 0n
        if (amountOut > best) best = amountOut
    }

    const quoteAerodromeV2 = async (
        factoryAddress: string | undefined,
        routerAddress: string | undefined
    ) => {
        if (!factoryAddress || !routerAddress) return
        const factory = new Contract(
            factoryAddress,
            AERO_V2_FACTORY_ABI,
            provider
        ) as unknown as AeroV2FactoryLike
        const router = new Contract(
            routerAddress,
            AERO_V2_ROUTER_ABI,
            provider
        ) as unknown as AeroV2RouterLike

        await Promise.all(
            [false, true].map(async (stablePool) => {
                const poolAddress = await factory
                    .getPool(token, stable, stablePool)
                    .catch(() => ZeroAddress)
                if (poolAddress === ZeroAddress) return
                const amounts = await router
                    .getAmountsOut(oneToken, [
                        {
                            from: token,
                            to: stable,
                            stable: stablePool,
                            factory: factoryAddress,
                        },
                    ])
                    .catch(() => null)
                const amountOut = amounts?.at(-1) ?? 0n
                if (amountOut > best) best = amountOut
            })
        )
    }

    await Promise.all([
        quoteStandardV2(
            poolHelper.addresses.factories.uniswapV2,
            poolHelper.addresses.routers.uniswapV2
        ),
        quoteStandardV2(
            poolHelper.addresses.factories.pancakeV2,
            poolHelper.addresses.routers.pancakeV2
        ),
        quoteAerodromeV2(
            poolHelper.addresses.factories.aerodromeV2,
            poolHelper.addresses.routers.aerodromeV2
        ),
    ])

    return best
}

async function _quoteDirectV3StablePools(
    token: string,
    stable: string,
    oneToken: bigint,
    poolHelper: PoolHelper,
    provider: Provider
): Promise<bigint> {
    let best = 0n

    const quoteFactory = async (
        factoryAddress: string | undefined,
        quoterAddress: string | undefined,
        fees: readonly number[]
    ) => {
        if (!factoryAddress || !quoterAddress) return
        const factory = new Contract(
            factoryAddress,
            V3_FACTORY_ABI,
            provider
        ) as unknown as V3FactoryLike
        const quoter = new Contract(
            quoterAddress,
            V3_QUOTER_ABI,
            provider
        ) as unknown as V3QuoterLike

        await Promise.all(
            fees.map(async (fee) => {
                const poolAddress = await factory
                    .getPool(token, stable, fee)
                    .catch(() => ZeroAddress)
                if (poolAddress === ZeroAddress) return

                const quote = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn: token,
                    tokenOut: stable,
                    amountIn: oneToken,
                    fee: BigInt(fee),
                    sqrtPriceLimitX96: 0n,
                }).catch(() => null)
                const amountOut = quote?.amountOut ?? 0n
                if (amountOut > best) best = amountOut
            })
        )
    }

    await Promise.all([
        quoteFactory(
            poolHelper.addresses.factories.uniswapV3,
            poolHelper.addresses.quoters.uniswapV3,
            UNISWAP_V3_FEES
        ),
        quoteFactory(
            poolHelper.addresses.factories.pancakeV3,
            poolHelper.addresses.quoters.pancakeV3,
            PANCAKE_V3_FEES
        ),
    ])

    return best
}

async function _quoteDirectAerodromeV3StablePool(
    token: string,
    stable: string,
    oneToken: bigint,
    poolHelper: PoolHelper,
    provider: Provider
): Promise<bigint> {
    const quoterAddress = poolHelper.addresses.quoters.aerodromeV3
    if (!quoterAddress) return 0n

    const factories = [
        poolHelper.addresses.factories.aerodromeV3,
        poolHelper.addresses.factories.aerodromeV3Bis,
    ].filter((factory): factory is string => Boolean(factory))
    if (factories.length === 0) return 0n

    const quoter = new Contract(
        quoterAddress,
        AERO_V3_QUOTER_ABI,
        provider
    ) as unknown as AeroV3QuoterLike

    let best = 0n
    await Promise.all(
        factories.flatMap((factoryAddress) => {
            const factory = new Contract(
                factoryAddress,
                AERO_V3_FACTORY_ABI,
                provider
            ) as unknown as AeroV3FactoryLike

            return AERODROME_V3_TICK_SPACINGS.map(async (tickSpacing) => {
                const poolAddress = await factory
                    .getPool(token, stable, tickSpacing)
                    .catch(() => ZeroAddress)
                if (poolAddress === ZeroAddress) return

                const quote = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn: token,
                    tokenOut: stable,
                    amountIn: oneToken,
                    tickSpacing: BigInt(tickSpacing),
                    sqrtPriceLimitX96: 0n,
                }).catch(() => null)
                const amountOut = quote?.amountOut ?? 0n
                if (amountOut > best) best = amountOut
            })
        })
    )

    return best
}

/**
 * Prices a token through its discovered direct V4 pools: 1 token → USDC
 * (USD parity, mirroring the WETH/USDT assumption above), else 1 token →
 * WETH converted via `wethUsd`. Returns null when the token has no usable
 * V4 pool either, letting the caller surface the original pricing error.
 */
async function _priceViaV4Pools(
    token: string,
    oneToken: bigint,
    getWethUsd: () => Promise<bigint>,
    ctx: {
        chainId: GuruProtocolChainId
        provider: Provider
    }
): Promise<bigint | null> {
    const addresses = getGuruProtocolAddresses(ctx.chainId)
    const quoterAddress = addresses.quoters.uniswapV4
    if (!quoterAddress) return null

    const quoter = connectV4Quoter(quoterAddress, ctx.provider)
    const WETH_UNIT = 10n ** 18n

    const quoteVia = async (counterpart: string): Promise<bigint | null> => {
        const paths = await discoverV4Paths(
            ctx.chainId,
            token,
            counterpart,
            ctx.provider
        ).catch(() => [])
        const quotes = await Promise.allSettled(
            paths.map((path) =>
                quoter.quoteExactInput.staticCall({
                    exactCurrency: token,
                    path: toAdapterPathKeys(path),
                    exactAmount: oneToken,
                })
            )
        )
        let best = 0n
        for (const result of quotes) {
            if (result.status !== 'fulfilled') continue
            const [amountOut] = result.value
            if (amountOut > best) best = amountOut
        }
        return best > 0n ? best : null
    }

    const inUsdc = await quoteVia(addresses.tokens.USDG ?? addresses.tokens.USDC)
    if (inUsdc !== null) {
        return inUsdc * 10n ** 12n // USDC (1e6) → USD 1e18
    }

    const inWeth = await quoteVia(addresses.tokens.WETH)
    if (inWeth !== null) {
        const wethUsd = await getWethUsd()
        return (inWeth * wethUsd) / WETH_UNIT
    }

    return null
}

export type {
    Route,
    RouteSearchParams,
    V2Path,
    V3Path,
    V3PathHop,
    V4Path,
    V4PathHop,
} from './types'
export type {
    SwapSimulator,
    SimulateSwapParams,
    SimulateSwapResult,
} from './simulation'
