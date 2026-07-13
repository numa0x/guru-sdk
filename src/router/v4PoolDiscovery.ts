import {
    AbiCoder,
    keccak256,
    zeroPadValue,
    type Filter,
    type Log,
    type Provider,
} from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolChainId,
} from '../addresses'
import compareAddresses from '../helpers/compareAddresses'
import {
    DEXSCREENER_ENDPOINT,
    V4_ZERO_ADDRESS,
    V4_DISCOVERY_MAX_POOLS,
    V4_DISCOVERY_MAX_LP_FEE,
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
    4663: {
        dexscreenerSlug: 'robinhood',
        poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
        deployBlock: 0,
    },
}

/**
 * Stable, hookless bridge pools used when indexers omit major/native pairs
 * from their capped token listings. PoolKeys are immutable and are still
 * quoted and simulation-validated before a route can be returned.
 */
const KNOWN_V4_BRIDGE_KEYS: Partial<Record<GuruProtocolChainId, V4PoolKey[]>> = {
    4663: [
        {
            currency0: V4_ZERO_ADDRESS,
            currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
            fee: 25,
            tickSpacing: 1,
            hooks: V4_ZERO_ADDRESS,
        },
        {
            currency0: V4_ZERO_ADDRESS,
            currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
            fee: 100,
            tickSpacing: 1,
            hooks: V4_ZERO_ADDRESS,
        },
        {
            currency0: V4_ZERO_ADDRESS,
            currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
            fee: 500,
            tickSpacing: 10,
            hooks: V4_ZERO_ADDRESS,
        },
    ],
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

/**
 * Discovery sources are untrusted. Reject pools whose immutable LP fee alone
 * can consume more than 10% of a swap. Dynamic-fee keys are accepted only
 * when they actually name a hook contract; their effective output must still
 * pass the V4 quoter and full execution simulation before becoming a route.
 */
export function isSafeDiscoveredV4PoolKey(key: V4PoolKey): boolean {
    const dynamicFeeFlag = 0x800000
    if (key.fee === dynamicFeeFlag) {
        return !compareAddresses(key.hooks, V4_ZERO_ADDRESS)
    }
    return key.fee >= 0 && key.fee <= V4_DISCOVERY_MAX_LP_FEE
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
    pairCreatedAt?: number
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
    provider: Provider,
    pairCreatedAt?: number
): Promise<V4PoolKey | null> {
    const cacheKey = `${chainId}:${poolId}`
    const cached = poolKeyCache.get(cacheKey)
    if (cached) return cached

    const config = V4_CHAIN_CONFIG[chainId]
    const filter: Filter = {
        address: config.poolManager,
        topics: [POOL_INITIALIZE_TOPIC, poolId],
        fromBlock: config.deployBlock,
        toBlock: 'latest',
    }
    let logs: Log[]
    try {
        logs = await provider.getLogs(filter)
    } catch {
        // Some RPCs (including Alchemy on Robinhood Chain) cap eth_getLogs at
        // 10,000 blocks. Search newest-first because discovered pools are
        // generally recent, and stop as soon as the indexed poolId is found.
        logs = []
        const latestBlock = await provider.getBlockNumber()
        const chunkSize = 9_999

        if (pairCreatedAt) {
            let low = config.deployBlock
            let high = latestBlock
            const targetTimestamp = Math.floor(pairCreatedAt / 1_000)
            while (low < high) {
                const middle = Math.floor((low + high) / 2)
                const block = await provider.getBlock(middle)
                if (!block) break
                if (block.timestamp < targetTimestamp) low = middle + 1
                else high = middle
            }

            const fromBlock = Math.max(config.deployBlock, low - 5_000)
            const toBlock = Math.min(latestBlock, fromBlock + chunkSize)
            logs = await provider.getLogs({
                ...filter,
                fromBlock,
                toBlock,
            })
        }

        if (logs.length === 0) {
            for (
                let toBlock = latestBlock;
                toBlock >= config.deployBlock;
                toBlock -= chunkSize + 1
            ) {
                const fromBlock = Math.max(config.deployBlock, toBlock - chunkSize)
                const chunk = await provider.getLogs({
                    ...filter,
                    fromBlock,
                    toBlock,
                })
                if (chunk.length > 0) {
                    logs = chunk
                    break
                }
            }
        }
    }
    const log = logs[0]
    if (!log) return null

    const key = poolKeyFromInitializeLog(log)
    if (!key) return null

    if (computeV4PoolId(key).toLowerCase() !== poolId.toLowerCase()) {
        return null
    }

    poolKeyCache.set(cacheKey, key)
    return key
}

function poolKeyFromInitializeLog(log: Log): V4PoolKey | null {
    const poolId = log.topics[1]
    if (!poolId || !log.topics[2] || !log.topics[3]) return null

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
    const majors = [
        tokens.WETH,
        tokens.USDC,
        tokens.USDT,
        tokens.USDG,
        V4_ZERO_ADDRESS,
    ].filter((token): token is string => Boolean(token))
    const isMajor = (token: string) =>
        majors.some((major) => compareAddresses(major, token))
    const queryOrder = isMajor(tokenIn) ? [tokenOut, tokenIn] : [tokenIn, tokenOut]

    let poolIds: string[] = []
    const pairCreatedAtByPoolId = new Map<string, number>()
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
        if (poolIds.length > 0) {
            for (const pair of pairs) {
                if (!pair.pairAddress || !pair.pairCreatedAt) continue
                pairCreatedAtByPoolId.set(
                    pair.pairAddress.toLowerCase(),
                    pair.pairCreatedAt
                )
            }
            break
        }
    }

    const keys = await Promise.all(
        poolIds.map((poolId) =>
            resolvePoolKey(
                chainId,
                poolId,
                provider,
                pairCreatedAtByPoolId.get(poolId)
            )
        )
    )

    const resolvedKeys = keys.filter(
        (key): key is V4PoolKey =>
            key !== null && isSafeDiscoveredV4PoolKey(key)
    )
    const knownKeys = findKnownV4BridgeKeys(chainId, tokenIn, tokenOut)
    const onchainKeys =
        resolvedKeys.length > 0 || knownKeys.length > 0
            ? []
            : await discoverOnchainDirectV4PoolKeys(
                  chainId,
                  tokenIn,
                  tokenOut,
                  provider
              ).catch(() => [])

    const paths: V4Path[] = resolvedKeys
        .concat(knownKeys)
        .concat(onchainKeys)
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

export function findKnownV4BridgeKeys(
    chainId: GuruProtocolChainId,
    tokenIn: string,
    tokenOut: string
): V4PoolKey[] {
    return (KNOWN_V4_BRIDGE_KEYS[chainId] ?? []).filter(
        (key) =>
            (compareAddresses(key.currency0, tokenIn) &&
                compareAddresses(key.currency1, tokenOut)) ||
            (compareAddresses(key.currency0, tokenOut) &&
                compareAddresses(key.currency1, tokenIn))
    )
}

async function discoverOnchainDirectV4PoolKeys(
    chainId: GuruProtocolChainId,
    tokenIn: string,
    tokenOut: string,
    provider: Provider
): Promise<V4PoolKey[]> {
    const config = V4_CHAIN_CONFIG[chainId]
    const [currency0, currency1] =
        tokenIn.toLowerCase() < tokenOut.toLowerCase()
            ? [tokenIn, tokenOut]
            : [tokenOut, tokenIn]

    const logs = await provider.getLogs({
        address: config.poolManager,
        topics: [
            POOL_INITIALIZE_TOPIC,
            null,
            zeroPadValue(currency0, 32),
            zeroPadValue(currency1, 32),
        ],
        fromBlock: config.deployBlock,
        toBlock: 'latest',
    })

    return logs
        .map(poolKeyFromInitializeLog)
        .filter(
            (key): key is V4PoolKey =>
                key !== null && isSafeDiscoveredV4PoolKey(key)
        )
        .sort((a, b) => a.fee - b.fee)
}

/** Test-only: clear the in-memory discovery caches. */
export function _clearV4DiscoveryCache(): void {
    discoveryCache.clear()
    poolKeyCache.clear()
}
