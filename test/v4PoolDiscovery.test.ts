import test from 'node:test'
import assert from 'node:assert/strict'

import { V4_ZERO_ADDRESS } from '../src/router/constants'
import { stitchNativeBridgeV4Paths } from '../src/router/v4PoolDiscovery'

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const ROOK = '0xaebb159c997a36d6de9efe1da4bf8262060899b3'

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
