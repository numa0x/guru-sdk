export const VELORA_ENDPOINT = 'https://api.velora.xyz/swap'

export const SUPPORTED_DEXS = [
    'UniswapV2',
    'UniswapV3',
    'UniswapV4',
    'AerodromeV2',
    'PancakeSwapV2',
    'PancakeSwapV3',
] as const

/**
 * Velora pricing-engine version required per DEX. UniswapV4 only exists in
 * the Augustus 6.2 engine; the API default is version 5, which silently
 * ignores unknown `includeDEXS` keys, so omitting this returns arbitrary
 * other DEXes instead of an error.
 */
export const VELORA_VERSION_BY_DEX: Partial<Record<SupportedDex, string>> = {
    UniswapV4: '6.2',
}

export type SupportedDex = (typeof SUPPORTED_DEXS)[number]

/** Initial slippage for simulation: 0.5% (E3: per 100_000, so 500 = 0.5%). */
export const INITIAL_SLIPPAGE_E3 = 500n

/** Cap effective slippage at 8% (8000 bps) so we never return nonsense from edge cases. */
export const MAX_EFFECTIVE_SLIPPAGE_BPS = 8_000n

/** Deadline offset for swap transactions: 30 minutes from now. */
export const SWAP_DEADLINE_SECONDS = 1800

/** Limit quoting to 3 hops. */
export const MAX_ROUTE_HOPS = 3

/** Max retries on rate-limit (429) errors. Worst-case wait: 16 retries × 500 ms base ≈ 60 s. */
export const RATE_LIMIT_MAX_RETRIES = 16

/** Base delay in ms between retries; attempt i waits (i+1) * BASE. */
export const SIMULATION_RETRY_BASE_DELAY_MS = 500

/** Number of candidate amounts to try in a bundle simulation (covers 0.5%-8% slippage range). */
export const BUNDLE_SIMULATION_CANDIDATES = 20

/** Max slippage we try in the bundle search: 8% (E3: 8000). */
export const MAX_SLIPPAGE_SEARCH_E3 = 8_000n

/** Positive path-cache TTL (1 hour). */
export const VELORA_PATH_CACHE_TTL = 1000 * 60 * 60

/** Negative path-cache TTL (1 minute) — avoids poisoning the cache on transient Velora failures. */
export const VELORA_NEGATIVE_CACHE_TTL = 1000 * 60

// ─── Uniswap V4 ──────────────────────────────────────────────────────────────
// Hookless V4 routing is sourced from Velora (version 6.2 engine) like the
// other DEXes. Hooked pools are invisible to aggregators (arbitrary hook code
// is untrusted) and live in an unenumerable keyspace, so when Velora has no
// route the SDK discovers the pair's V4 pools via Dexscreener and resolves
// their immutable PoolKeys on-chain — see `v4PoolDiscovery.ts`.

/** Uniswap V4 native-currency / no-hooks sentinel (address zero). */
export const V4_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Dexscreener pair listing endpoint (free, keyless; ~300 req/min). */
export const DEXSCREENER_ENDPOINT = 'https://api.dexscreener.com/token-pairs/v1'

/** Ignore discovered pools below this Dexscreener liquidity (USD). */
export const V4_DISCOVERY_MIN_LIQUIDITY_USD = 10_000

/** Quote at most this many discovered pools per pair (deepest first). */
export const V4_DISCOVERY_MAX_POOLS = 3
