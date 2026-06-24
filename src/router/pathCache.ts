import compareAddresses from '../helpers/compareAddresses'
import {
    VELORA_ENDPOINT,
    VELORA_NEGATIVE_CACHE_TTL,
    VELORA_PATH_CACHE_TTL,
    VELORA_VERSION_BY_DEX,
    type SupportedDex,
} from './constants'
import type {
    CachedPath,
    V3Path,
    V4Path,
    VeloraRouteResponseAerodromeV2,
    VeloraRouteResponse,
    VeloraRouteResponseV2,
    VeloraRouteResponseV3,
    VeloraRouteResponseV4,
    VeloraV4Hop,
} from './types'

export interface GetPathParams {
    chainId: number
    dex: SupportedDex
    tokenIn: string
    tokenOut: string
    srcDecimals: number
    destDecimals: number
    vault: string
}

export type PathFetcher = (params: GetPathParams) => Promise<CachedPath>

/**
 * Extract the path the SDK can replay on-chain from a Velora API response.
 * V2 responses carry the address path verbatim; V3 responses split a multi-hop
 * route across multiple `swaps`, so we concatenate the hops back into a single
 * path the V3 quoter can encode via `solidityPacked`.
 */
export function extractPathFromResponse(
    dex: SupportedDex,
    response: VeloraRouteResponse<unknown>
): CachedPath {
    if (dex === 'UniswapV4') {
        return extractV4Path(response as VeloraRouteResponseV4)
    }

    if (dex === 'AerodromeV2') {
        const v2Response = response as VeloraRouteResponseAerodromeV2
        const exchange =
            v2Response.priceRoute.bestRoute[0]!.swaps[0]!.swapExchanges[0]!
        const path = exchange.data.path
        if (!Array.isArray(path) || typeof path[0] !== 'string') {
            throw new Error('Unexpected Aerodrome V2 path structure')
        }
        const routes = path.slice(0, -1).map((from, i) => ({
            from,
            to: path[i + 1]!,
            stable: Boolean(exchange.data.pools?.[i]?.stable),
            factory: exchange.data.factory,
        }))
        return { type: 'aerodromeV2', path, routes, hops: path.length - 1 }
    }

    if (dex === 'UniswapV2' || dex === 'PancakeSwapV2') {
        const v2Response = response as VeloraRouteResponseV2
        const path =
            v2Response.priceRoute.bestRoute[0]!.swaps[0]!.swapExchanges[0]!
                .data.path
        return { type: 'v2', path, hops: path.length - 1 }
    }

    const v3Response = response as VeloraRouteResponseV3
    const swaps = v3Response.priceRoute.bestRoute[0]!.swaps
    const combinedPath: V3Path = []

    for (const swap of swaps) {
        const swapPath = swap.swapExchanges[0]!.data.path
        if (
            !Array.isArray(swapPath) ||
            typeof swapPath[0]?.tokenIn !== 'string' ||
            typeof swapPath[0]?.fee !== 'string'
        ) {
            throw new Error('Unexpected V3 path structure')
        }
        combinedPath.push(...swapPath)
    }

    return { type: 'v3', path: combinedPath, hops: combinedPath.length }
}

/** Convert one Velora V4 hop to the SDK's V4 path-hop shape. */
function toV4PathHop(hop: VeloraV4Hop): V4Path[number] {
    return {
        tokenIn: hop.tokenIn,
        tokenOut: hop.tokenOut,
        fee: Number(hop.pool.key.fee),
        tickSpacing: hop.pool.key.tickSpacing,
        hooks: hop.pool.key.hooks,
        hookData: '0x',
    }
}

/**
 * Stitch a Velora V4 response into a single replayable path.
 *
 * Velora may split a leg across several pools (`swapExchanges` percentages)
 * and treats ETH/WETH as fungible at leg boundaries (its settlement layer
 * wraps/unwraps); our adapter replays one exact-input path, so we pick one
 * exchange per leg — preferring the largest split — and require consecutive
 * legs to chain on the actual pool currencies. Native intermediate hops are
 * fine (deltas net out inside the PoolManager); a combination that would
 * leave a native/WETH mismatch at a boundary is rejected, falling back to
 * other split combinations and ultimately to a negative cache entry.
 */
export function extractV4Path(response: VeloraRouteResponseV4): CachedPath {
    const swaps = response.priceRoute.bestRoute[0]!.swaps
    const legs = swaps.map((swap) =>
        [...swap.swapExchanges].sort((a, b) => b.percent - a.percent)
    )

    const combinedPath: V4Path = []

    const tryLeg = (index: number, previousOut: string | null): boolean => {
        if (index === legs.length) return true
        for (const exchange of legs[index]) {
            const hops = exchange.data.path
            if (!Array.isArray(hops) || hops.length === 0) continue
            if (typeof hops[0]?.tokenIn !== 'string' || !hops[0]?.pool?.key) {
                throw new Error('Unexpected V4 path structure')
            }
            if (
                previousOut !== null &&
                !compareAddresses(hops[0].tokenIn, previousOut)
            ) {
                continue
            }
            combinedPath.push(...hops.map(toV4PathHop))
            if (tryLeg(index + 1, hops[hops.length - 1].tokenOut)) return true
            combinedPath.length -= hops.length
        }
        return false
    }

    if (!tryLeg(0, null)) {
        throw new Error('Unexpected V4 path structure')
    }

    // Endpoints must be the ERC20s of the request: the vault cannot custody
    // native currency, and the adapter rejects native endpoints on-chain.
    const first = combinedPath[0]
    const last = combinedPath[combinedPath.length - 1]
    if (
        !compareAddresses(first.tokenIn, response.priceRoute.srcToken) ||
        !compareAddresses(last.tokenOut, response.priceRoute.destToken)
    ) {
        throw new Error('Unexpected V4 path structure')
    }

    return { type: 'v4', path: combinedPath, hops: combinedPath.length }
}

interface CacheEntry {
    path: CachedPath
    timestamp: number
}

const pathCache = new Map<string, CacheEntry>()

/**
 * Fetch the optimal swap path for a token pair via Velora's DEX aggregator API.
 *
 * Uses an in-memory cache: positive paths cache for `VELORA_PATH_CACHE_TTL` (1h),
 * negatives (no route / transient error) cache for `VELORA_NEGATIVE_CACHE_TTL` (1m)
 * to avoid poisoning.
 *
 * @param params - Token pair and chain info
 * @param endpoint - Velora API endpoint (defaults to `https://api.velora.xyz/swap`)
 */
export async function getPath(
    {
        chainId,
        dex,
        tokenIn,
        tokenOut,
        srcDecimals,
        destDecimals,
        vault,
    }: GetPathParams,
    endpoint: string = VELORA_ENDPOINT
): Promise<CachedPath> {
    const cacheKey = `${chainId}:${dex}:${tokenIn}:${tokenOut}`
    const cache = pathCache.get(cacheKey)
    const ttl = cache?.path
        ? VELORA_PATH_CACHE_TTL
        : VELORA_NEGATIVE_CACHE_TTL
    const cacheExpired = cache && Date.now() - cache.timestamp > ttl

    if (cache && !cacheExpired) return cache.path

    const url = new URL(endpoint)
    url.searchParams.set('network', String(chainId))
    url.searchParams.set('userAddress', vault)
    url.searchParams.set('srcToken', tokenIn)
    url.searchParams.set('srcDecimals', srcDecimals.toString())
    url.searchParams.set('destToken', tokenOut)
    url.searchParams.set('destDecimals', destDecimals.toString())
    url.searchParams.set('amount', (10 ** srcDecimals).toString())
    url.searchParams.set('side', 'SELL')
    url.searchParams.set('slippage', '100')
    url.searchParams.set('includeDEXS', dex)

    const version = VELORA_VERSION_BY_DEX[dex]
    if (version) url.searchParams.set('version', version)

    let response = await fetch(url.toString())
    if (!response.ok && (response.status === 429 || response.status >= 500)) {
        await new Promise((r) => setTimeout(r, 300))
        response = await fetch(url.toString())
    }
    if (!response.ok) {
        pathCache.set(cacheKey, { path: false, timestamp: Date.now() })
        return false
    }

    const veloraResponse =
        (await response.json()) as VeloraRouteResponse<unknown>
    const extractedPath = extractPathFromResponse(dex, veloraResponse)

    pathCache.set(cacheKey, {
        path: extractedPath,
        timestamp: Date.now(),
    })
    return extractedPath
}

/** Test-only: clear the in-memory path cache. */
export function _clearPathCache(): void {
    pathCache.clear()
}
