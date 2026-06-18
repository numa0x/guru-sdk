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
        const pairedToken = compareAddresses(tokenIn, weth) ? tokenOut : tokenIn
        const coinTokenPool =
            await poolHelper.getUniswapCompatibleTokenPool(pairedToken)

        return quoteWethTrade({
            feeTier: coinTokenPool.feeTier,
            input: { tokenIn, tokenOut, amountIn, slippage },
            poolHelper,
            finalization,
        })
    }

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
        const pairedToken = compareAddresses(tokenIn, weth) ? tokenOut : tokenIn
        const coinTokenPool =
            await poolHelper.getUniswapCompatibleTokenPool(pairedToken)

        const route = await quoteWethTrade({
            feeTier: coinTokenPool.feeTier,
            input: { tokenIn, tokenOut, amountIn, slippage },
            poolHelper,
            finalization,
        })

        return { ...route, hops: 1 }
    }

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
