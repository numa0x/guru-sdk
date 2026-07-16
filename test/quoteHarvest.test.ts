import test from 'node:test'
import assert from 'node:assert/strict'

import { computeHarvestProjection } from '../src/quotes/quoteHarvest'

const UNIT = 10n ** 18n

test('computeHarvestProjection liquidates only management fees when TVL is below virtual principal', () => {
    const managementFee = 116n * UNIT / 10n // $11.60

    const projection = computeHarvestProjection({
        tvl: 3_200n * UNIT,
        totalVirtualPrincipal: 60_000n * UNIT,
        profitFeeBps: 2_000n,
        managementFee,
    })

    assert.equal(projection.harvestProjection, managementFee)
    assert.equal(projection.harvestableFraction, 3_625_000_000_000_000n)
    assert.ok(projection.harvestableFraction < UNIT / 100n)
})

test('computeHarvestProjection combines chargeable profit and management fees in USD-1e18 units', () => {
    const projection = computeHarvestProjection({
        tvl: 1_200n * UNIT,
        totalVirtualPrincipal: 1_000n * UNIT,
        profitFeeBps: 2_000n,
        managementFee: 10n * UNIT,
    })

    assert.equal(projection.harvestProjection, 50n * UNIT)
    assert.equal(projection.harvestableFraction, 41_666_666_666_666_666n)
})

test('computeHarvestProjection clamps chargeable profit to zero', () => {
    const projection = computeHarvestProjection({
        tvl: 1_000n * UNIT,
        totalVirtualPrincipal: 1_001n * UNIT,
        profitFeeBps: 2_000n,
        managementFee: 0n,
    })

    assert.deepEqual(projection, {
        harvestProjection: 0n,
        harvestableFraction: 0n,
    })
})
