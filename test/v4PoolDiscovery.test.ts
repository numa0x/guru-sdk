import test from 'node:test'
import assert from 'node:assert/strict'
import { AbiCoder, zeroPadValue, type Provider } from 'ethers'

import { V4_ZERO_ADDRESS } from '../src/router/constants'
import {
    _clearV4DiscoveryCache,
    computeV4PoolId,
    discoverV4Paths,
    isSafeDiscoveredV4PoolKey,
    stitchNativeBridgeV4Paths,
} from '../src/router/v4PoolDiscovery'

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const ROOK = '0xaebb159c997a36d6de9efe1da4bf8262060899b3'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'
const POOL_INITIALIZE_TOPIC =
    '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'

test('rejects the 92% Robinhood USDG/FIH V4 pool used in the loss transaction', () => {
    assert.equal(
        isSafeDiscoveredV4PoolKey({
            currency0: USDG,
            currency1: '0x4b3a3ff4ec9d289727e24a8152f406bada44264d',
            fee: 920_000,
            tickSpacing: 18_400,
            hooks: V4_ZERO_ADDRESS,
        }),
        false
    )
})

test('accepts ordinary discovered V4 static fees', () => {
    assert.equal(
        isSafeDiscoveredV4PoolKey({
            currency0: USDG,
            currency1: NVDA,
            fee: 10_000,
            tickSpacing: 200,
            hooks: V4_ZERO_ADDRESS,
        }),
        true
    )
})

test('stitches ERC20 -> native -> ERC20 V4 bridge paths', () => {
    const paths = stitchNativeBridgeV4Paths(
        [
            [
                {
                    tokenIn: USDT,
                    tokenOut: V4_ZERO_ADDRESS,
                    fee: 500,
                    tickSpacing: 10,
                    hooks: V4_ZERO_ADDRESS,
                    hookData: '0x',
                },
            ],
        ],
        [
            [
                {
                    tokenIn: V4_ZERO_ADDRESS,
                    tokenOut: ROOK,
                    fee: 500,
                    tickSpacing: 10,
                    hooks: '0x2d924c45de5530b947c4ac45d27202e7a21280cc',
                    hookData: '0x',
                },
            ],
        ]
    )

    assert.equal(paths.length, 1)
    assert.deepEqual(
        paths[0]!.map((hop) => [hop.tokenIn, hop.tokenOut]),
        [
            [USDT, V4_ZERO_ADDRESS],
            [V4_ZERO_ADDRESS, ROOK],
        ]
    )
})

test('does not stitch paths unless native is the shared intermediate', () => {
    const paths = stitchNativeBridgeV4Paths(
        [
            [
                {
                    tokenIn: USDT,
                    tokenOut: ROOK,
                    fee: 500,
                    tickSpacing: 10,
                    hooks: V4_ZERO_ADDRESS,
                    hookData: '0x',
                },
            ],
        ],
        [
            [
                {
                    tokenIn: V4_ZERO_ADDRESS,
                    tokenOut: ROOK,
                    fee: 500,
                    tickSpacing: 10,
                    hooks: V4_ZERO_ADDRESS,
                    hookData: '0x',
                },
            ],
        ]
    )

    assert.equal(paths.length, 0)
})

test('discovers direct V4 pools from PoolManager logs when Dexscreener misses them', async () => {
    _clearV4DiscoveryCache()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
        new Response(JSON.stringify([]), { status: 200 })) as typeof fetch

    const poolKey = {
        currency0: USDG,
        currency1: NVDA,
        fee: 3000,
        tickSpacing: 60,
        hooks: V4_ZERO_ADDRESS,
    }
    const poolId = computeV4PoolId(poolKey)
    const provider = {
        getLogs: async () => [
            {
                topics: [
                    POOL_INITIALIZE_TOPIC,
                    poolId,
                    zeroPadValue(USDG, 32),
                    zeroPadValue(NVDA, 32),
                ],
                data: AbiCoder.defaultAbiCoder().encode(
                    ['uint24', 'int24', 'address', 'uint160', 'int24'],
                    [poolKey.fee, poolKey.tickSpacing, poolKey.hooks, 1n, 1]
                ),
            },
        ],
    } as unknown as Provider

    try {
        const paths = await discoverV4Paths(4663, USDG, NVDA, provider)

        assert.deepEqual(paths, [
            [
                {
                    tokenIn: USDG,
                    tokenOut: NVDA,
                    fee: 3000,
                    tickSpacing: 60,
                    hooks: V4_ZERO_ADDRESS,
                    hookData: '0x',
                },
            ],
        ])
    } finally {
        globalThis.fetch = originalFetch
        _clearV4DiscoveryCache()
    }
})

test('locates a bounded PoolManager verification range from pair creation time', async () => {
    _clearV4DiscoveryCache()
    const originalFetch = globalThis.fetch
    const poolKey = {
        currency0: V4_ZERO_ADDRESS,
        currency1: NVDA,
        fee: 50_000,
        tickSpacing: 1_000,
        hooks: V4_ZERO_ADDRESS,
    }
    const poolId = computeV4PoolId(poolKey)
    globalThis.fetch = (async () =>
        new Response(
            JSON.stringify([
                {
                    dexId: 'uniswap',
                    labels: ['v4'],
                    pairAddress: poolId,
                    baseToken: { address: NVDA },
                    quoteToken: { address: V4_ZERO_ADDRESS },
                    liquidity: { usd: 100_000 },
                    pairCreatedAt: 10_000_000,
                },
            ]),
            { status: 200 }
        )) as typeof fetch

    const ranges: Array<[number, number | string]> = []
    const log = {
        topics: [
            POOL_INITIALIZE_TOPIC,
            poolId,
            zeroPadValue(V4_ZERO_ADDRESS, 32),
            zeroPadValue(NVDA, 32),
        ],
        data: AbiCoder.defaultAbiCoder().encode(
            ['uint24', 'int24', 'address', 'uint160', 'int24'],
            [poolKey.fee, poolKey.tickSpacing, poolKey.hooks, 1n, 1]
        ),
    }
    const provider = {
        getBlockNumber: async () => 25_000,
        getBlock: async (blockNumber: number) => ({ timestamp: blockNumber }),
        getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number | string }) => {
            ranges.push([fromBlock, toBlock])
            if (toBlock === 'latest') throw new Error('maximum 10000 block range')
            return fromBlock === 5_000 ? [log] : []
        },
    } as unknown as Provider

    try {
        const paths = await discoverV4Paths(4663, NVDA, V4_ZERO_ADDRESS, provider)
        assert.equal(paths.length, 1)
        assert.deepEqual(ranges, [
            [0, 'latest'],
            [5_000, 14_999],
        ])
    } finally {
        globalThis.fetch = originalFetch
        _clearV4DiscoveryCache()
    }
})
