import { parseEther, type Provider } from 'ethers'

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
import type { PathFetcher } from './pathCache'
import PoolHelper from './poolHelper'
import type { SwapSimulator } from './simulation'
import type { Route, RouteSearchParams } from './types'
import { discoverV4Paths } from './v4PoolDiscovery'

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
    return tryWithVeloraFallback(
        () =>
            veloraThenV4Discovery(
                () => getVeloraRoute(params, veloraCtx),
                () => getUniswapV4Route(params, v4Ctx)
            ),
        () => getFallbackRouteIn(params, fallbackCtx)
    )
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
    return tryWithVeloraFallback(
        () =>
            veloraThenV4Discovery(
                () => getVeloraRoute(params, veloraCtx),
                () => getUniswapV4Route(params, v4Ctx)
            ),
        () => getFallbackRouteOut(params, fallbackCtx)
    )
}

/**
 * Returns the on-chain USD price of `token` as a 1e18-scaled bigint.
 *
 * Strategy mirrors the legacy `EvmPriceFetcher`:
 *   1. Quote 1 WETH → USDT via PoolHelper (best DEX wins) → wethUsd
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
    const poolHelper = new PoolHelper({
        chainId: ctx.chainId,
        provider: ctx.provider,
        getSwapFeePercentage: ctx.getSwapFeePercentage,
    })

    // Pricing scans every DEX with on-chain liquidity, including those without
    // a Guru Protocol adapter — we only need a price, not a swap route.
    const { amount: wethUsdt } = await poolHelper.getBestQuote({
        tokenAmount: parseEther('1'),
        path: [addresses.tokens.WETH, addresses.tokens.USDT],
        requireSwappable: false,
    })

    const wethUsd = wethUsdt * 10n ** 12n // USDT (1e6) → USD 1e18

    if (compareAddresses(token, addresses.tokens.WETH)) {
        return wethUsd
    }

    const { decimals } = await new Token(token, ctx.provider)
        .metadata()
        .catch(() => ({ decimals: 0 }))
    const oneToken = 10n ** BigInt(decimals)

    const WETH_UNIT = 10n ** 18n

    try {
        const { amount: oneTokenInWeth } = await poolHelper.getBestQuote({
            tokenAmount: oneToken,
            path: [token, addresses.tokens.WETH],
            requireSwappable: false,
        })
        return (oneTokenInWeth * wethUsd) / WETH_UNIT
    } catch (error) {
        // V2/V3-less tokens (V4-only, e.g. hooked-pool launches) are invisible
        // to PoolHelper's factory scan — fall back to discovered V4 pools.
        const v4Usd = await _priceViaV4Pools(token, oneToken, wethUsd, ctx)
        if (v4Usd !== null) return v4Usd
        throw error
    }
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
    wethUsd: bigint,
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

    const inUsdc = await quoteVia(addresses.tokens.USDC)
    if (inUsdc !== null) {
        return inUsdc * 10n ** 12n // USDC (1e6) → USD 1e18
    }

    const inWeth = await quoteVia(addresses.tokens.WETH)
    if (inWeth !== null) {
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
