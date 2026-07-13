import type { Provider } from 'ethers'

import compareAddresses from '../helpers/compareAddresses'
import { FundVault__factory } from '../typechain'
import PoolHelper from './poolHelper'
import { quoteWethTrade } from './quoteWethTrade'
import type { SwapSimulator } from './simulation'
import type { Route, RouteSearchParams } from './types'

export interface GetFallbackRouteContext {
    provider: Provider
    simulator: SwapSimulator
    /** PoolHelper requires the protocol's swap fee — typically read from a fund factory or vault. */
    getSwapFeePercentage: () => Promise<bigint>
}

async function tryWethBridgeV2Route(
    poolHelper: PoolHelper,
    input: {
        tokenIn: string
        tokenOut: string
        amountIn: bigint
        slippage: bigint
    },
    finalization: Parameters<typeof quoteWethTrade>[0]['finalization']
): Promise<Route | null> {
    const factory = poolHelper.addresses.factories.uniswapV2
    if (!factory || !poolHelper.addresses.adapters.uniswapV2) return null

    for (const bridge of poolHelper.addresses.routeBridges ?? []) {
        try {
            return await quoteWethTrade({
                feeTier: 0,
                input: {
                    ...input,
                    path: [input.tokenIn, bridge, input.tokenOut],
                    exchangeFactory: factory,
                },
                poolHelper,
                finalization,
            })
        } catch {
            // Try the next configured bridge.
        }
    }
    return null
}

async function tryDirectAerodromeV2RouteIn(
    poolHelper: PoolHelper,
    {
        tokenIn,
        tokenOut,
        amountIn,
        slippage,
        finalization,
    }: {
        tokenIn: string
        tokenOut: string
        amountIn: bigint
        slippage: bigint
        finalization: Parameters<
            PoolHelper['getStableForTokenQuote']
        >[0]['finalization']
    }
): Promise<Route | null> {
    const factory = poolHelper.addresses.factories.aerodromeV2
    if (!factory || !poolHelper.addresses.adapters.aerodromeV2) return null

    try {
        const route = await poolHelper.getStableForTokenQuote({
            path: [tokenIn, tokenOut],
            inputAmount: amountIn,
            slippage,
            exchangeFactory: factory,
            finalization,
        })
        return { ...route, hops: 1 }
    } catch {
        return null
    }
}

async function tryDirectAerodromeV2RouteOut(
    poolHelper: PoolHelper,
    {
        tokenIn,
        tokenOut,
        amountIn,
        slippage,
        finalization,
    }: {
        tokenIn: string
        tokenOut: string
        amountIn: bigint
        slippage: bigint
        finalization: Parameters<
            PoolHelper['getTokensForStableQuote']
        >[0]['finalization']
    }
): Promise<Route | null> {
    const factory = poolHelper.addresses.factories.aerodromeV2
    if (!factory || !poolHelper.addresses.adapters.aerodromeV2) return null

    try {
        const route = await poolHelper.getTokensForStableQuote({
            path: [tokenIn, tokenOut],
            inputAmount: amountIn,
            slippage,
            exchangeFactory: factory,
            finalization,
        })
        return { ...route, hops: 1 }
    } catch {
        return null
    }
}

/**
 * Deposit fallback: build a route assuming `tokenIn → WETH → tokenOut`. If
 * `tokenOut` is WETH itself, the path collapses to a direct swap. Mirrors
 * `apps/trpc/src/services/get-route/get-fallback-routes.ts`.
 */
export async function getFallbackRouteIn(
    params: RouteSearchParams,
    ctx: GetFallbackRouteContext
): Promise<Route> {
    const { chainId, tokenIn, tokenOut, amountIn, slippageE2 } = params
    const slippage = BigInt(slippageE2 ?? 500) * 10n

    const poolHelper = new PoolHelper({
        chainId,
        provider: ctx.provider,
        getSwapFeePercentage: ctx.getSwapFeePercentage,
    })
    const weth = poolHelper.addresses.tokens.WETH
    const [controller, blockNumber] = await Promise.all([
        FundVault__factory.connect(params.vault, ctx.provider).controller(),
        ctx.provider.getBlockNumber(),
    ])
    const finalization = {
        blockNumber,
        controller,
        vault: params.vault,
        account: params.account,
        simulator: ctx.simulator,
        prefixTxs: params.prefixTxs,
        maxSlippageE3: slippage,
    }

    if (compareAddresses(tokenIn, weth) || compareAddresses(tokenOut, weth)) {
        try {
            const pairedToken = compareAddresses(tokenIn, weth) ? tokenOut : tokenIn
            const coinTokenPool =
                await poolHelper.getUniswapCompatibleTokenPool(pairedToken)

            return await quoteWethTrade({
                feeTier: coinTokenPool.feeTier,
                input: { tokenIn, tokenOut, amountIn, slippage },
                poolHelper,
                finalization,
            })
        } catch (directError) {
            const bridged = await tryWethBridgeV2Route(
                poolHelper,
                { tokenIn, tokenOut, amountIn, slippage },
                finalization
            )
            if (bridged) return bridged
            throw directError
        }
    }

    const directAerodrome = await tryDirectAerodromeV2RouteIn(poolHelper, {
        tokenIn,
        tokenOut,
        amountIn,
        slippage,
        finalization,
    })
    if (directAerodrome) return directAerodrome

    const pool = await poolHelper.getUniswapCompatibleTokenPool(tokenOut)
    const path: [string, string, string] = [tokenIn, weth, tokenOut]

    const route = await poolHelper.getStableForTokenQuote({
        path,
        inputAmount: amountIn,
        slippage,
        exchangeFactory: pool.exchangeFactory,
        finalization,
    })

    return { ...route, hops: 2 }
}

/**
 * Withdrawal fallback: assumes `tokenIn → WETH → tokenOut` with the toll on
 * the output side. Symmetric to `getFallbackRouteIn`.
 */
export async function getFallbackRouteOut(
    params: RouteSearchParams,
    ctx: GetFallbackRouteContext
): Promise<Route> {
    const { chainId, tokenIn, tokenOut, amountIn, slippageE2 } = params
    const slippage = BigInt(slippageE2 ?? 500) * 10n

    const poolHelper = new PoolHelper({
        chainId,
        provider: ctx.provider,
        getSwapFeePercentage: ctx.getSwapFeePercentage,
    })
    const weth = poolHelper.addresses.tokens.WETH
    const [controller, blockNumber] = await Promise.all([
        FundVault__factory.connect(params.vault, ctx.provider).controller(),
        ctx.provider.getBlockNumber(),
    ])
    const finalization = {
        blockNumber,
        controller,
        vault: params.vault,
        account: params.account,
        simulator: ctx.simulator,
        prefixTxs: params.prefixTxs,
        maxSlippageE3: slippage,
    }

    if (compareAddresses(tokenIn, weth) || compareAddresses(tokenOut, weth)) {
        try {
            const pairedToken = compareAddresses(tokenIn, weth) ? tokenOut : tokenIn
            const coinTokenPool =
                await poolHelper.getUniswapCompatibleTokenPool(pairedToken)

            return await quoteWethTrade({
                feeTier: coinTokenPool.feeTier,
                input: { tokenIn, tokenOut, amountIn, slippage },
                poolHelper,
                finalization,
            })
        } catch (directError) {
            const bridged = await tryWethBridgeV2Route(
                poolHelper,
                { tokenIn, tokenOut, amountIn, slippage },
                finalization
            )
            if (bridged) return bridged
            throw directError
        }
    }

    const directAerodrome = await tryDirectAerodromeV2RouteOut(poolHelper, {
        tokenIn,
        tokenOut,
        amountIn,
        slippage,
        finalization,
    })
    if (directAerodrome) return directAerodrome

    const pool = await poolHelper.getUniswapCompatibleTokenPool(tokenIn)
    const path: [string, string, string] = [tokenIn, weth, tokenOut]

    const route = await poolHelper.getTokensForStableQuote({
        path,
        inputAmount: amountIn,
        slippage,
        exchangeFactory: pool.exchangeFactory,
        finalization,
    })

    return { ...route, hops: 2 }
}
