import test from 'node:test'
import assert from 'node:assert/strict'

import {
    allocateDepositInputAmounts,
    rebalanceDepositInputAmounts,
} from '../src/quotes/quoteDeposit'
import type { Fund } from '../src/types/Fund'

const UNIT = 10n ** 18n

function asset(
    address: string,
    balance: bigint,
    usd1e18Price = UNIT
): Fund.Asset {
    return {
        index: 0,
        token: {
            address,
            decimals: 18,
            symbol: 'TKN',
            name: 'Token',
        },
        balance,
        usd1e18Price,
        weight: 0n,
        depositWeight: 0n,
    }
}

test('allocateDepositInputAmounts gives dust assets a non-zero input when value is below coarse weight precision', () => {
    const whale = asset(
        '0x0000000000000000000000000000000000000001',
        999_999n * UNIT
    )
    const dust = asset('0x0000000000000000000000000000000000000002', UNIT)
    const assets = [whale, dust]
    const totalValueLocked = 1_000_000n * UNIT

    const allocations = allocateDepositInputAmounts(
        assets,
        12_000_000n,
        totalValueLocked
    )

    assert.equal(
        allocations.get(whale.token.address.toLowerCase())! +
            allocations.get(dust.token.address.toLowerCase())!,
        12_000_000n
    )
    assert.equal(allocations.get(dust.token.address.toLowerCase()), 12n)
})

test('allocateDepositInputAmounts rescues assets that would round to zero', () => {
    const whale = asset(
        '0x0000000000000000000000000000000000000001',
        1_000_000n * UNIT
    )
    const dust = asset('0x0000000000000000000000000000000000000002', 1n)
    const assets = [whale, dust]
    const totalAmount = 1_000_000n

    const allocations = allocateDepositInputAmounts(
        assets,
        totalAmount,
        whale.balance + dust.balance
    )

    assert.equal(
        allocations.get(whale.token.address.toLowerCase())! +
            allocations.get(dust.token.address.toLowerCase())!,
        totalAmount
    )
    assert.equal(allocations.get(dust.token.address.toLowerCase()), 2n)
    assert.ok(allocations.get(whale.token.address.toLowerCase())! > 0n)
})

test('rebalanceDepositInputAmounts shifts input toward routes that under-deliver asset ratio', () => {
    const cheap = asset('0x0000000000000000000000000000000000000001', 100n)
    const expensive = asset('0x0000000000000000000000000000000000000002', 100n)

    const allocations = rebalanceDepositInputAmounts(
        [
            {
                asset: cheap,
                amountIn: 50n,
                amountOut: 50n,
            },
            {
                asset: expensive,
                amountIn: 50n,
                amountOut: 25n,
            },
        ],
        100n
    )

    assert.equal(allocations.get(cheap.token.address.toLowerCase()), 33n)
    assert.equal(allocations.get(expensive.token.address.toLowerCase()), 67n)
})
