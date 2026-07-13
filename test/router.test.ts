import test from 'node:test'
import assert from 'node:assert/strict'

import { tryWithVeloraFallback } from '../src/router'
import { getGuruProtocolAddresses, isSupportedChainId } from '../src/addresses'
import { applyV4Toll } from '../src/router/getUniswapV4Route'
import type { Route } from '../src/router'
import { SUPPORTED_DEXS } from '../src/router/constants'
import { extractPathFromResponse } from '../src/router/pathCache'
import type PoolHelper from '../src/router/poolHelper'
import { rankUsablePools } from '../src/router/poolHelper'
import { quoteWethTrade } from '../src/router/quoteWethTrade'
import { findMaxPassingAmountToReceive } from '../src/router/simulation'
import { buildVeloraDexConfig } from '../src/router/velora'
import buildTradesTx from '../src/txBuilders/buildTradesTx'
import { bestOfDirectAndComposite } from '../src/quotes/quoteTrade'
import { FundController__factory } from '../src/typechain'
import type {
    VeloraRouteResponseAerodromeV2,
    VeloraRouteResponseV3,
} from '../src/router/types'

const fakeRoute = (label: string): Route => ({
    adapter: '0xadapter',
    data: {
        amountToReceive: label === 'velora' ? 100n : 50n,
        amountToSend: 1n,
        path: ['0x', '0x'],
        deadline: 0,
    },
    callData: '0x',
    toll: { currency: '0x', amount: 0n },
    hops: 1,
})

test('simulation search is sequential and stops after two passing candidates', async () => {
    let calls = 0
    let active = 0
    let maxActive = 0

    const amount = await findMaxPassingAmountToReceive({
        chainId: 4663,
        blockNumber: 1,
        controller: '0x0000000000000000000000000000000000000001',
        vault: '0x0000000000000000000000000000000000000002',
        adapter: '0x0000000000000000000000000000000000000003',
        account: '0x0000000000000000000000000000000000000004',
        path: [
            '0x0000000000000000000000000000000000000005',
            '0x0000000000000000000000000000000000000006',
        ],
        amountQuoted: 1_000n,
        amountWithSlippage: 990n,
        amountIn: 1n,
        buildCallDataForAmount: () => '0x',
        simulator: async () => {
            calls += 1
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
            return { success: calls >= 3 }
        },
    })

    assert.equal(calls, 4)
    assert.equal(maxActive, 1)
    assert.ok(amount < 990n)
})

test('trade routing keeps a better executable composite route over direct', async () => {
    const direct = { ...fakeRoute('direct'), data: { ...fakeRoute('direct').data, amountToReceive: 80n } }
    const first = fakeRoute('first')
    const second = { ...fakeRoute('second'), data: { ...fakeRoute('second').data, amountToReceive: 100n } }

    assert.deepEqual(
        await bestOfDirectAndComposite(
            async () => direct,
            async () => [first, second]
        ),
        [first, second]
    )
})

test('buildTradesTx encodes an atomic executeTrades call', () => {
    const tx = buildTradesTx({
        controller: '0x0000000000000000000000000000000000000001',
        ledger: '0x0000000000000000000000000000000000000002',
        adapters: [
            '0x0000000000000000000000000000000000000003',
            '0x0000000000000000000000000000000000000004',
        ],
        callData: ['0x1234', '0xabcd'],
        from: '0x0000000000000000000000000000000000000005',
    })
    const parsed = FundController__factory.createInterface().parseTransaction({
        data: String(tx.data),
    })
    assert.equal(parsed?.name, 'executeTrades')
    assert.deepEqual([...parsed!.args[1]], [
        '0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000004',
    ])
})

test('pool ranking rejects a deeper V3 pool with zero active liquidity', () => {
    const pools = rankUsablePools([
        {
            address: '0x95A29612221FAfD6C1CE207b57AdB2d5D7D91252',
            feeTier: 3000,
            exchangeFactory: '0xfactory',
            wethBalance: 1_045n,
            activeLiquidity: 0n,
        },
        {
            address: '0xed26Ce48B4aea533f526C1Aa6218870E5a52B39D',
            feeTier: 10000,
            exchangeFactory: '0xfactory',
            wethBalance: 1_015n,
            activeLiquidity: 1_951n,
        },
    ])

    assert.deepEqual(
        pools.map((pool) => pool.feeTier),
        [10000]
    )
})

test('Velora-has-route: returns Velora result, fallback never invoked', async () => {
    let fallbackCalls = 0
    const result = await tryWithVeloraFallback(
        async () => fakeRoute('velora'),
        async () => {
            fallbackCalls += 1
            return fakeRoute('fallback')
        }
    )
    assert.equal(fallbackCalls, 0)
    assert.equal(result.data.amountToReceive, 100n)
})

test('Velora-empty: Velora throws, fallback returns', async () => {
    let veloraCalls = 0
    let fallbackCalls = 0
    const result = await tryWithVeloraFallback(
        async () => {
            veloraCalls += 1
            throw new Error('NO_VELORA_ROUTES_FOUND')
        },
        async () => {
            fallbackCalls += 1
            return fakeRoute('fallback')
        }
    )
    assert.equal(veloraCalls, 1)
    assert.equal(fallbackCalls, 1)
    assert.equal(result.data.amountToReceive, 50n)
})

test('Velora rejects synchronously (thrown sync error) → fallback runs', async () => {
    let fallbackCalls = 0
    const result = await tryWithVeloraFallback<Route>(
        // sync throw before returning a promise
        (() => {
            throw new Error('sync boom')
        }) as () => Promise<Route>,
        async () => {
            fallbackCalls += 1
            return fakeRoute('fallback')
        }
    )
    assert.equal(fallbackCalls, 1)
    assert.equal(result.data.amountToReceive, 50n)
})

test('Both branches reject: error propagates from fallback', async () => {
    await assert.rejects(
        tryWithVeloraFallback<Route>(
            async () => {
                throw new Error('velora-down')
            },
            async () => {
                throw new Error('fallback-down')
            }
        ),
        /fallback-down/
    )
})

test('TOKEN_LOCKED_BY_V4_HOOK bypasses generic fallback', async () => {
    let fallbackCalls = 0
    await assert.rejects(
        tryWithVeloraFallback<Route>(
            async () => {
                throw new Error('TOKEN_LOCKED_BY_V4_HOOK')
            },
            async () => {
                fallbackCalls += 1
                return fakeRoute('fallback')
            }
        ),
        /TOKEN_LOCKED_BY_V4_HOOK/
    )
    assert.equal(fallbackCalls, 0)
})

test('UNISWAP_V4_HOOK_ROUTE_REVERTED bypasses generic fallback', async () => {
    let fallbackCalls = 0
    await assert.rejects(
        tryWithVeloraFallback<Route>(
            async () => {
                throw new Error('UNISWAP_V4_HOOK_ROUTE_REVERTED')
            },
            async () => {
                fallbackCalls += 1
                return fakeRoute('fallback')
            }
        ),
        /UNISWAP_V4_HOOK_ROUTE_REVERTED/
    )
    assert.equal(fallbackCalls, 0)
})

test('quoteWethTrade uses the pre-slipped best quote as amountToReceive', async () => {
    const weth = '0x4200000000000000000000000000000000000006'
    const token = '0x09f87f948c88848363b124c9099cbb58e4cc7cb6'
    const adapter = '0xefccd55c1c4a471d72f37f84d65361ed708d22d7'
    const exchangeFactory = '0x8909dc15e40173ff4699343b6eb8132c65e18ec6'

    const poolHelper = {
        addresses: { tokens: { WETH: weth } },
        getBestQuote: async () => ({
            amount: 950n,
            feeTier: 0,
            swapFee: 2n,
            router: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
            exchangeFactory,
        }),
        getLotusAdapter: () => adapter,
        getDexData: () => ({ type: 'v2', kind: 'uniswap' }),
    } as unknown as PoolHelper

    const route = await quoteWethTrade({
        feeTier: 0,
        input: {
            tokenIn: weth,
            tokenOut: token,
            amountIn: 1000n,
            slippage: 5_000n,
        },
        poolHelper,
    })

    assert.equal(route.data.amountToReceive, 950n)
})

test('quoteWethTrade preserves a configured V2 bridge path', async () => {
    const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
    const virtual = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31'
    const token = '0xc7c9341765c3beebf0ea2ab05e69b68991a9a470'
    const factory = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f'
    const path = [weth, virtual, token]
    let quotedPath: string[] = []

    const poolHelper = {
        addresses: { tokens: { WETH: weth } },
        getBestQuote: async (request: { path: string[] }) => {
            quotedPath = request.path
            return {
                amount: 950n,
                feeTier: 0,
                swapFee: 2n,
                router: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
                exchangeFactory: factory,
            }
        },
        getLotusAdapter: () =>
            '0xdeb704836165043c172ae80467249ff87429605f',
        getDexData: () => ({ type: 'v2', kind: 'uniswap' }),
    } as unknown as PoolHelper

    const route = await quoteWethTrade({
        feeTier: 0,
        input: {
            tokenIn: weth,
            tokenOut: token,
            amountIn: 1000n,
            slippage: 500n,
            path,
            exchangeFactory: factory,
        },
        poolHelper,
    })

    assert.deepEqual(quotedPath, path)
    assert.deepEqual('path' in route.data ? route.data.path : null, path)
    assert.equal(route.hops, 2)
})

test('applyV4Toll keeps zero-rounded input toll at zero', () => {
    const route = applyV4Toll({
        tollIn: true,
        baseToll: {
            currency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            amount: 0n,
        },
        quotedAmountToReceive: 1_000n,
        quoteSource: 'quoter',
        swapAmountIn: 2n,
    })

    assert.equal(route.toll.amount, 0n)
    assert.equal(route.amountQuoted, 1_000n)
    assert.equal(route.amountToSend, 2n)
    assert.equal(route.initialTollAmount, 0n)
})

test('applyV4Toll deducts output toll when toll is not on input', () => {
    const route = applyV4Toll({
        tollIn: false,
        baseToll: {
            currency: '0x4200000000000000000000000000000000000006',
            amount: 0n,
        },
        quotedAmountToReceive: 1_000n,
        quoteSource: 'quoter',
        swapAmountIn: 2n,
    })

    assert.equal(route.toll.amount, 2n)
    assert.equal(route.amountQuoted, 998n)
    assert.equal(route.amountToSend, 2n)
    assert.equal(route.initialTollAmount, 0n)
})

test('quoteWethTrade rejects fallback route when all simulations fail', async () => {
    const weth = '0x4200000000000000000000000000000000000006'
    const token = '0x09f87f948c88848363b124c9099cbb58e4cc7cb6'
    const adapter = '0xefccd55c1c4a471d72f37f84d65361ed708d22d7'
    const exchangeFactory = '0x8909dc15e40173ff4699343b6eb8132c65e18ec6'

    const poolHelper = {
        chainId: 8453,
        addresses: { tokens: { WETH: weth } },
        getBestQuote: async ({ slippage }: { slippage: bigint }) => {
            assert.equal(slippage, 0n)
            return {
                amount: 1000n,
                feeTier: 0,
                swapFee: 2n,
                router: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
                exchangeFactory,
            }
        },
        getLotusAdapter: () => adapter,
        getDexData: () => ({ type: 'v2', kind: 'uniswap' }),
    } as unknown as PoolHelper

    await assert.rejects(
        () =>
            quoteWethTrade({
                feeTier: 0,
                input: {
                    tokenIn: weth,
                    tokenOut: token,
                    amountIn: 1000n,
                    slippage: 500n,
                },
                poolHelper,
                finalization: {
                    blockNumber: 1,
                    controller: '0x0000000000000000000000000000000000000001',
                    vault: '0x0000000000000000000000000000000000000002',
                    account: '0x0000000000000000000000000000000000000003',
                    simulator: async () => ({ success: false }),
                    maxSlippageE3: 6000n,
                },
            }),
        /NO_EXECUTABLE_ROUTE_FOUND/
    )
})

test('Base Velora config enables Aerodrome routes', () => {
    const addresses = getGuruProtocolAddresses(8453)
    const cfg = buildVeloraDexConfig(addresses)

    assert.ok(SUPPORTED_DEXS.includes('AerodromeV2'))
    assert.ok(SUPPORTED_DEXS.includes('AerodromeV3'))
    assert.equal(cfg.AerodromeV2?.adapter, addresses.adapters.aerodromeV2)
    assert.equal(
        cfg.AerodromeV2?.routerAddress,
        addresses.routers.aerodromeV2
    )
    assert.equal(cfg.AerodromeV3?.adapter, addresses.adapters.aerodromeV3)
    assert.equal(
        cfg.AerodromeV3?.quoterAddress,
        addresses.quoters.aerodromeV3
    )
})

test('Robinhood address registry exposes Lotus, USDG, and Uniswap routes', () => {
    assert.equal(isSupportedChainId(4663), true)

    const addresses = getGuruProtocolAddresses(4663)
    const cfg = buildVeloraDexConfig(addresses)

    assert.equal(
        addresses.protocol,
        '0xe0d99cd8bf9f091713c88ff763d669ad3703876c'
    )
    assert.equal(
        addresses.tokens.USDG,
        '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
    )
    assert.equal(addresses.tokens.USDC, addresses.tokens.USDG)
    assert.equal(addresses.tokens.USDT, addresses.tokens.USDG)
    assert.equal(cfg.UniswapV2?.adapter, addresses.adapters.uniswapV2)
    assert.equal(cfg.UniswapV3?.adapter, addresses.adapters.uniswapV3)
})

test('extractPathFromResponse preserves Aerodrome V2 route metadata', () => {
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    const handl = '0x3bbcb624cb9a1f73163a886f460f47603e5e4425'
    const factory = '0x420dd381b31aef6683db6b902084cb0ffece40da'
    const response = {
        priceRoute: {
            bestRoute: [
                {
                    swaps: [
                        {
                            swapExchanges: [
                                {
                                    data: {
                                        path: [usdc, handl],
                                        factory,
                                        pools: [{ stable: false }],
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    } as unknown as VeloraRouteResponseAerodromeV2

    const cached = extractPathFromResponse('AerodromeV2', response)

    assert.ok(cached && cached.type === 'aerodromeV2')
    assert.equal(cached.hops, 1)
    assert.deepEqual(cached.routes, [
        { from: usdc, to: handl, stable: false, factory },
    ])
})

test('extractPathFromResponse uses Aerodrome V3 tick spacing for Slipstream paths', () => {
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    const rize = '0x9818b6c09f5ecc843060927e8587c427c7c93583'
    const response = {
        priceRoute: {
            bestRoute: [
                {
                    swaps: [
                        {
                            swapExchanges: [
                                {
                                    data: {
                                        path: [
                                            {
                                                tokenIn: usdc,
                                                tokenOut: rize,
                                                fee: '3000',
                                                currentFee: '3000',
                                                tickSpacing: '200',
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    } as unknown as VeloraRouteResponseV3

    const cached = extractPathFromResponse('AerodromeV3', response)

    assert.ok(cached && cached.type === 'v3')
    assert.equal(cached.hops, 1)
    assert.deepEqual(cached.path, [
        {
            tokenIn: usdc,
            tokenOut: rize,
            fee: '200',
            currentFee: '3000',
            tickSpacing: '200',
        },
    ])
})

// ─── Uniswap V4 route source ─────────────────────────────────────────────────

import { bestOfV4AndFallback, veloraThenV4Discovery } from '../src/router'
import {
    applyV4Toll,
    toAdapterPathKeys,
    toHookAdapterPathKeys,
} from '../src/router/getUniswapV4Route'
import { extractV4Path } from '../src/router/pathCache'
import { V4_ZERO_ADDRESS } from '../src/router/constants'
import {
    computeV4PoolId,
    selectV4PairPoolIds,
} from '../src/router/v4PoolDiscovery'
import type { VeloraRouteResponseV4, VeloraV4Hop } from '../src/router/types'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933'
const VRTX = '0xb4589127a468f9fea9da3c8c9e39c48fdfd982fa'
const VRTX_HOOKS = '0x068f3dd75f3537bc5b396bc0ead71b832c0c2acc'
const VRTX_USDC_POOL_ID =
    '0x09ba9c328135392be58594a6283133691d36a7f7e647b281661165ff20cdb11a'

const v4FakeRoute = (amountToReceive: bigint): Route => ({
    adapter: '0xadapter',
    data: {
        amountToReceive,
        amountToSend: 1n,
        path: ['0x', '0x'],
        deadline: 0,
    },
    callData: '0x',
    toll: { currency: '0x', amount: 0n },
    hops: 1,
})

test('veloraThenV4Discovery: Velora route wins, discovery never runs', async () => {
    let discoveryCalls = 0
    const route = await veloraThenV4Discovery(
        async () => v4FakeRoute(100n),
        async () => {
            discoveryCalls += 1
            return v4FakeRoute(999n)
        }
    )
    assert.equal(discoveryCalls, 0)
    assert.equal(route.data.amountToReceive, 100n)
})

test('veloraThenV4Discovery: Velora miss falls through to V4 discovery', async () => {
    const route = await veloraThenV4Discovery(
        async () => {
            throw new Error('NO_VELORA_ROUTES_FOUND')
        },
        async () => v4FakeRoute(42n)
    )
    assert.equal(route.data.amountToReceive, 42n)
})

test('veloraThenV4Discovery: both miss → error propagates (triggers fallback)', async () => {
    await assert.rejects(
        veloraThenV4Discovery(
            async () => {
                throw new Error('NO_VELORA_ROUTES_FOUND')
            },
            async () => {
                throw new Error('NO_UNISWAP_V4_ROUTES_FOUND')
            }
        ),
        /NO_UNISWAP_V4_ROUTES_FOUND/
    )
})

test('bestOfV4AndFallback: rejects an executable but economically worse V4 quote', async () => {
    const v4 = fakeRoute('fallback')
    const fallback = fakeRoute('velora')

    const result = await bestOfV4AndFallback(
        async () => v4,
        async () => fallback
    )

    assert.equal(result.data.amountToReceive, 100n)
})

test('bestOfV4AndFallback: keeps a V4-only route when ordinary fallback fails', async () => {
    const result = await bestOfV4AndFallback(
        async () => fakeRoute('fallback'),
        async () => {
            throw new Error('NO_V2_V3_ROUTE')
        }
    )

    assert.equal(result.data.amountToReceive, 50n)
})

// ─── V4 pool discovery ───────────────────────────────────────────────────────

test('computeV4PoolId: reproduces the real VRTX/USDC hooked poolId', () => {
    assert.equal(
        computeV4PoolId({
            currency0: USDC,
            currency1: VRTX,
            fee: 0,
            tickSpacing: 60,
            hooks: VRTX_HOOKS,
        }),
        VRTX_USDC_POOL_ID
    )
})

test('selectV4PairPoolIds: filters to liquid v4 pairs of the pair, deepest first', () => {
    const ids = selectV4PairPoolIds(
        [
            // wrong dex
            { dexId: 'sushiswap', labels: ['v4'], pairAddress: '0x01', baseToken: { address: VRTX }, quoteToken: { address: USDC }, liquidity: { usd: 500_000 } },
            // not v4
            { dexId: 'uniswap', labels: ['v3'], pairAddress: '0x02', baseToken: { address: VRTX }, quoteToken: { address: USDC }, liquidity: { usd: 500_000 } },
            // wrong counterparty token
            { dexId: 'uniswap', labels: ['v4'], pairAddress: '0x03', baseToken: { address: VRTX }, quoteToken: { address: PEPE }, liquidity: { usd: 500_000 } },
            // below liquidity floor (the $36 USDS dust pools)
            { dexId: 'uniswap', labels: ['v4'], pairAddress: '0x04', baseToken: { address: VRTX }, quoteToken: { address: USDC }, liquidity: { usd: 36 } },
            // valid, shallower
            { dexId: 'uniswap', labels: ['v4'], pairAddress: '0x0B', baseToken: { address: USDC }, quoteToken: { address: VRTX }, liquidity: { usd: 50_000 } },
            // valid, deepest
            { dexId: 'uniswap', labels: ['v4'], pairAddress: '0x0A', baseToken: { address: VRTX }, quoteToken: { address: USDC }, liquidity: { usd: 197_000 } },
        ],
        USDC,
        VRTX
    )
    assert.deepEqual(ids, ['0x0a', '0x0b'])
})

test('toAdapterPathKeys: maps SDK hops to adapter PathKey encoding', () => {
    const keys = toAdapterPathKeys([
        {
            tokenIn: USDC,
            tokenOut: VRTX,
            fee: 0,
            tickSpacing: 60,
            hooks: VRTX_HOOKS,
            hookData: '0x',
        },
    ])
    assert.deepEqual(keys, [
        {
            intermediateCurrency: VRTX,
            fee: 0,
            tickSpacing: 60,
            hooks: VRTX_HOOKS,
            hookData: '0x',
        },
    ])
})

test('toHookAdapterPathKeys: includes input currency for hook executor paths', () => {
    const keys = toHookAdapterPathKeys([
        {
            tokenIn: USDC,
            tokenOut: V4_ZERO_ADDRESS,
            fee: 500,
            tickSpacing: 10,
            hooks: VRTX_HOOKS,
            hookData: '0x1234',
        },
    ])
    assert.deepEqual(keys, [
        {
            inputCurrency: USDC,
            intermediateCurrency: V4_ZERO_ADDRESS,
            fee: 500,
            tickSpacing: 10,
            hook: VRTX_HOOKS,
            hookData: '0x1234',
        },
    ])
})

// ─── extractV4Path: stitching real Velora v6.2 splits ────────────────────────

const v4Hop = (
    tokenIn: string,
    tokenOut: string,
    fee: string,
    tickSpacing: number
): VeloraV4Hop => ({
    pool: {
        id: '0x' + 'ab'.repeat(32),
        key: {
            currency0: tokenIn < tokenOut ? tokenIn : tokenOut,
            currency1: tokenIn < tokenOut ? tokenOut : tokenIn,
            fee,
            tickSpacing,
            hooks: V4_ZERO_ADDRESS,
        },
    },
    tokenIn,
    tokenOut,
    zeroForOne: tokenIn < tokenOut,
})

const v4Response = (
    srcToken: string,
    destToken: string,
    legs: { percent: number; path: VeloraV4Hop[] }[][]
): VeloraRouteResponseV4 =>
    ({
        priceRoute: {
            srcToken,
            destToken,
            bestRoute: [
                {
                    percent: 100,
                    swaps: legs.map((exchanges) => ({
                        swapExchanges: exchanges.map((exchange) => ({
                            exchange: 'uniswapv4',
                            percent: exchange.percent,
                            data: { path: exchange.path },
                        })),
                    })),
                },
            ],
        },
    }) as unknown as VeloraRouteResponseV4

test('extractV4Path: single-hop response', () => {
    const cached = extractV4Path(
        v4Response(USDC, PEPE, [[{ percent: 100, path: [v4Hop(USDC, PEPE, '3000', 60)] }]])
    )
    assert.ok(cached && cached.type === 'v4')
    assert.equal(cached.hops, 1)
    assert.equal(cached.path[0].fee, 3000)
})

test('extractV4Path: picks largest split per leg and chains on native', () => {
    // Mirrors the live USDC->PEPE shape: leg 1 splits 84% (out: native) /
    // 16% (out: WETH); leg 2 splits 2% / 98%, both native-in. The largest
    // splits chain through native.
    const cached = extractV4Path(
        v4Response(USDC, PEPE, [
            [
                { percent: 84, path: [v4Hop(USDC, V4_ZERO_ADDRESS, '100', 1)] },
                { percent: 16, path: [v4Hop(USDC, WETH, '500', 10)] },
            ],
            [
                { percent: 2, path: [v4Hop(V4_ZERO_ADDRESS, PEPE, '3000', 60)] },
                { percent: 98, path: [v4Hop(V4_ZERO_ADDRESS, PEPE, '10000', 200)] },
            ],
        ])
    )
    assert.ok(cached && cached.type === 'v4')
    assert.equal(cached.hops, 2)
    assert.equal(cached.path[0].fee, 100) // 84% split won leg 1
    assert.equal(cached.path[0].tokenOut, V4_ZERO_ADDRESS)
    assert.equal(cached.path[1].fee, 10000) // 98% split won leg 2
})

test('extractV4Path: backtracks when the largest splits do not chain', () => {
    // Leg 1's largest split outputs WETH but leg 2 only accepts native; the
    // extractor must fall back to leg 1's smaller native-out split.
    const cached = extractV4Path(
        v4Response(USDC, PEPE, [
            [
                { percent: 84, path: [v4Hop(USDC, WETH, '500', 10)] },
                { percent: 16, path: [v4Hop(USDC, V4_ZERO_ADDRESS, '100', 1)] },
            ],
            [{ percent: 100, path: [v4Hop(V4_ZERO_ADDRESS, PEPE, '10000', 200)] }],
        ])
    )
    assert.ok(cached && cached.type === 'v4')
    assert.equal(cached.path[0].fee, 100)
    assert.equal(cached.path[0].tokenOut, V4_ZERO_ADDRESS)
})

test('extractV4Path: rejects routes with a native endpoint', () => {
    // If Velora's only chainable route ends in native (it wraps in its own
    // settlement), the vault cannot replay it — must throw, not mis-route.
    assert.throws(
        () =>
            extractV4Path(
                v4Response(USDC, WETH, [
                    [{ percent: 100, path: [v4Hop(USDC, V4_ZERO_ADDRESS, '100', 1)] }],
                ])
            ),
        /Unexpected V4 path structure/
    )
})

test('applyV4Toll: quoter output quotes are normalized from gross to net', () => {
    const result = applyV4Toll({
        baseToll: { currency: USDC, amount: 0n },
        quotedAmountToReceive: 10_000n,
        quoteSource: 'quoter',
        swapAmountIn: 1_000n,
    })

    assert.deepEqual(result, {
        toll: { currency: USDC, amount: 20n },
        amountQuoted: 9_980n,
        amountToSend: 1_000n,
        initialTollAmount: 0n,
    })
})

test('applyV4Toll: adapter preview output quotes are already net', () => {
    const result = applyV4Toll({
        baseToll: { currency: USDC, amount: 0n },
        quotedAmountToReceive: 9_980n,
        quoteSource: 'adapter-preview',
        swapAmountIn: 1_000n,
    })

    assert.deepEqual(result, {
        toll: { currency: USDC, amount: 0n },
        amountQuoted: 9_980n,
        amountToSend: 1_000n,
        initialTollAmount: 0n,
    })
})

test('applyV4Toll: input toll restores adapter amountToSend', () => {
    const result = applyV4Toll({
        baseToll: { currency: WETH, amount: 2n },
        quotedAmountToReceive: 10_000n,
        quoteSource: 'adapter-preview',
        swapAmountIn: 998n,
    })

    assert.deepEqual(result, {
        toll: { currency: WETH, amount: 2n },
        amountQuoted: 10_000n,
        amountToSend: 1_000n,
        initialTollAmount: 2n,
    })
})
