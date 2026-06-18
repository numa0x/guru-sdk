import { AbiCoder, keccak256, type Provider } from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolChainId,
} from '../addresses'
import compareAddresses from '../helpers/compareAddresses'
import {
    DEXSCREENER_ENDPOINT,
    V4_ZERO_ADDRESS,
    V4_DISCOVERY_MAX_POOLS,
    V4_DISCOVERY_MIN_LIQUIDITY_USD,
    VELORA_NEGATIVE_CACHE_TTL,
    VELORA_PATH_CACHE_TTL,
} from './constants'
import type { V4Path } from './types'

// ─── Per-chain V4 infrastructure ─────────────────────────────────────────────

const V4_CHAIN_CONFIG: Record<
    GuruProtocolChainId,
    { dexscreenerSlug: string; poolManager: string; deployBlock: number }
> = {
    1: {
        dexscreenerSlug: 'ethereum',
        poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
        deployBlock: 21_600_000, // shortly before the V4 PoolManager deploy
    },
    8453: {
        dexscreenerSlug: 'base',
        poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
        deployBlock: 25_000_000, // shortly before the V4 PoolManager deploy
    },
}

/// keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
const POOL_INITIALIZE_TOPIC =
    '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'

// ─── Pool key model ──────────────────────────────────────────────────────────

export interface V4PoolKey {
    currency0: string
    currency1: string
    fee: number
    tickSpacing: number
    hooks: string
}

/** Recompute a poolId from its key: keccak256(abi.encode(PoolKey)). */
export function computeV4PoolId(key: V4PoolKey): string {
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
        )
    )
}

// ─── Dexscreener pair listing ────────────────────────────────────────────────

interface DexscreenerPair {
    dexId?: string
    labels?: string[]
    pairAddress?: string
    baseToken?: { address?: string }
    quoteToken?: { address?: string }
    liquidity?: { usd?: number }
}

/**
 * Selects the V4 poolIds connecting tokenIn/tokenOut from a Dexscreener pair
 * listing: `uniswap`-dex pairs labelled `v4`, above the liquidity floor,
 * deepest first, capped at `V4_DISCOVERY_MAX_POOLS`. Exported for unit tests.
 */
export function selectV4PairPoolIds(
    pairs: DexscreenerPair[],
    tokenIn: string,
    tokenOut: string
): string[] {
    return pairs
        .filter((pair) => {
            const base = pair.baseToken?.address
            const quote = pair.quoteToken?.address
            if (!base || !quote || !pair.pairAddress) return false
            const connects =
                (compareAddresses(base, tokenIn) &&
                    compareAddresses(quote, tokenOut)) ||
                (compareAddresses(base, tokenOut) &&
                    compareAddresses(quote, tokenIn))
            return (
                connects &&
                pair.dexId === 'uniswap' &&
                (pair.labels ?? []).includes('v4') &&
                (pair.liquidity?.usd ?? 0) >= V4_DISCOVERY_MIN_LIQUIDITY_USD
            )
        })
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
        .slice(0, V4_DISCOVERY_MAX_POOLS)
        .map((pair) => pair.pairAddress!.toLowerCase())
}

export function stitchNativeBridgeV4Paths(
    firstLegs: V4Path[],
    secondLegs: V4Path[]
): V4Path[] {
    const paths: V4Path[] = []

    for (const firstLeg of firstLegs) {
        const firstHop = firstLeg.at(-1)
        if (!firstHop || !compareAddresses(firstHop.tokenOut, V4_ZERO_ADDRESS)) {
            continue
        }

        for (const secondLeg of secondLegs) {
            const secondHop = secondLeg[0]
            if (!secondHop || !compareAddresses(secondHop.tokenIn, V4_ZERO_ADDRESS)) {
                continue
            }

            paths.push([...firstLeg, ...secondLeg])
            if (paths.length >= V4_DISCOVERY_MAX_POOLS) return paths
        }
    }

    return paths
}

// ─── PoolKey resolution ──────────────────────────────────────────────────────

// PoolKeys are immutable once a pool is initialized — cache resolutions forever.
const poolKeyCache = new Map<string, V4PoolKey>()

/**
 * Resolves a poolId to its PoolKey from the PoolManager `Initialize` event
 * (one indexed `eth_getLogs`), and verifies it by re-hashing: a poolId that
 * doesn't match its claimed key is discarded, so a wrong or malicious
 * Dexscreener answer can never steer the route into a different pool.
 */
async function resolvePoolKey(
    chainId: GuruProtocolChainId,
    poolId: string,
    provider: Provider
): Promise<V4PoolKey | null> {
    const cacheKey = `${chainId}:${poolId}`
    const cached = poolKeyCache.get(cacheKey)
    if (cached) return cached

    const config = V4_CHAIN_CONFIG[chainId]
    const logs = await provider.getLogs({
        address: config.poolManager,
        topics: [POOL_INITIALIZE_TOPIC, poolId],
        fromBlock: config.deployBlock,
        toBlock: 'latest',
    })
    const log = logs[0]
    if (!log) return null

    const [fee, tickSpacing, hooks] = AbiCoder.defaultAbiCoder().decode(
        ['uint24', 'int24', 'address', 'uint160', 'int24'],
        log.data
    )
    // topics: [signature, poolId, currency0, currency1]
    const key: V4PoolKey = {
        currency0: '0x' + log.topics[2]!.slice(26),
        currency1: '0x' + log.topics[3]!.slice(26),
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks: String(hooks),
    }

    if (computeV4PoolId(key).toLowerCase() !== poolId.toLowerCase()) {
        return null
    }

    poolKeyCache.set(cacheKey, key)
    return key
}

// ─── Discovery ───────────────────────────────────────────────────────────────

interface DiscoveryCacheEntry {
    paths: V4Path[]
    timestamp: number
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>()

/**
 * Discovers direct Uniswap V4 pools for a token pair that aggregators cannot
 * see (hooked pools live in an unenumerable keyspace and are not indexed).
 *
 * One cached Dexscreener call lists the pair's V4 poolIds with liquidity;
 * each poolId resolves to its immutable PoolKey on-chain. Positive results
 * cache for an hour, misses for a minute — mirroring the Velora path cache —
 * so pairs without V4 pools cost a single HTTP probe per minute at worst.
 *
 * Endpoints are the request's ERC20s by construction (pairs are matched on
 * tokenIn/tokenOut), so the adapter's no-native-endpoint rule always holds.
 */
export async function discoverV4Paths(
    chainId: GuruProtocolChainId,
    tokenIn: string,
    tokenOut: string,
    provider: Provider,
    endpoint: string = DEXSCREENER_ENDPOINT
): Promise<V4Path[]> {
    const cacheKey = `${chainId}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
    const cached = discoveryCache.get(cacheKey)
    const ttl = cached?.paths.length
        ? VELORA_PATH_CACHE_TTL
        : VELORA_NEGATIVE_CACHE_TTL
    if (cached && Date.now() - cached.timestamp <= ttl) return cached.paths

    let paths = await discoverDirectV4Paths(
        chainId,
        tokenIn,
        tokenOut,
        provider,
        endpoint,
        cached?.paths
    )

    if (
        paths.length === 0 &&
        !compareAddresses(tokenIn, V4_ZERO_ADDRESS) &&
        !compareAddresses(tokenOut, V4_ZERO_ADDRESS)
    ) {
        const [firstLegs, secondLegs] = await Promise.all([
            discoverDirectV4Paths(
                chainId,
                tokenIn,
                V4_ZERO_ADDRESS,
                provider,
                endpoint
            ),
            discoverDirectV4Paths(
                chainId,
                V4_ZERO_ADDRESS,
                tokenOut,
                provider,
                endpoint
            ),
        ])
        paths = stitchNativeBridgeV4Paths(firstLegs, secondLegs)
    }

    discoveryCache.set(cacheKey, { paths, timestamp: Date.now() })
    return paths
}

async function discoverDirectV4Paths(
    chainId: GuruProtocolChainId,
    tokenIn: string,
    tokenOut: string,
    provider: Provider,
    endpoint: string,
    cachedPaths?: V4Path[]
): Promise<V4Path[]> {
    const config = V4_CHAIN_CONFIG[chainId]

    // Dexscreener caps a token's pair listing at its top pairs, so querying a
    // major token (USDC's thousands of pools) can miss the pair. Query the
    // exotic side first — one side is always WETH/a stablecoin in our flows —
    // and only fall back to the other side's listing if it yields nothing.
    const { tokens } = getGuruProtocolAddresses(chainId)
    const majors = [tokens.WETH, tokens.USDC, tokens.USDT, V4_ZERO_ADDRESS]
    const isMajor = (token: string) =>
        majors.some((major) => compareAddresses(major, token))
    const queryOrder = isMajor(tokenIn) ? [tokenOut, tokenIn] : [tokenIn, tokenOut]

    let poolIds: string[] = []
    for (const queryToken of queryOrder) {
        const response = await fetch(
            `${endpoint}/${config.dexscreenerSlug}/${queryToken}`
        )
        if (!response.ok) {
            // Don't poison the cache on transient Dexscreener failures.
            return cachedPaths ?? []
        }
        const pairs = (await response.json()) as DexscreenerPair[]
        poolIds = selectV4PairPoolIds(pairs, tokenIn, tokenOut)
        if (poolIds.length > 0) break
    }

    const keys = await Promise.all(
        poolIds.map((poolId) => resolvePoolKey(chainId, poolId, provider))
    )

    const paths: V4Path[] = keys
        .filter((key): key is V4PoolKey => key !== null)
        .map((key) => [
            {
                tokenIn,
                tokenOut,
                fee: key.fee,
                tickSpacing: key.tickSpacing,
                hooks: key.hooks,
                hookData: '0x',
            },
        ])
    return paths
}

/** Test-only: clear the in-memory discovery caches. */
export function _clearV4DiscoveryCache(): void {
    discoveryCache.clear()
    poolKeyCache.clear()
}
