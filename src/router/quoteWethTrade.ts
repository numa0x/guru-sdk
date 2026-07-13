import { type BytesLike, solidityPacked } from 'ethers'

import compareAddresses from '../helpers/compareAddresses'
import {
    AerodromeV2Adapter__factory,
    UniswapV2Adapter__factory,
    UniswapV3Adapter__factory,
} from '../typechain'
import type { SwapAeroV2Struct } from '../typechain/out/AerodromeV2Adapter'
import type { SwapV2Struct } from '../typechain/out/UniswapV2Adapter'
import type { SwapV3Struct } from '../typechain/out/UniswapV3Adapter'
import { finalizeRouteQuote } from './finalizeRoute'
import PoolHelper, {
    type FeeTier,
    type PoolRouteFinalizationContext,
} from './poolHelper'
import type { SwapSimulationContext } from './simulation'
import type { Route } from './types'

export interface QuoteWethTradeParams {
    feeTier: FeeTier
    input: {
        tokenIn: string
        tokenOut: string
        amountIn: bigint
        slippage: bigint
        path?: string[]
        exchangeFactory?: string
    }
    poolHelper: PoolHelper
    finalization?: PoolRouteFinalizationContext
}

/**
 * Quote a single-hop swap where one side is WETH. Picks the deepest
 * `$TOKEN/$WETH` pool across every DEX in the chain registry (Uniswap V2/V3,
 * PancakeSwap V3, Aerodrome V2/V3) and encodes the call against the matching
 * adapter. The `feeTier` arg is retained as a default for the bytes-packed V3
 * path; the actual pool tier is sourced from the picked quote.
 */
export async function quoteWethTrade({
    feeTier,
    input,
    poolHelper,
    finalization,
}: QuoteWethTradeParams): Promise<Route> {
    const weth = poolHelper.addresses.tokens.WETH
    const routePath = input.path ?? [input.tokenIn, input.tokenOut]

    const wethIn = compareAddresses(input.tokenIn, weth)
    const wethOut = compareAddresses(input.tokenOut, weth)

    if (!wethIn && !wethOut) {
        throw new Error('quoteWethTrade: path does not include WETH')
    }

    const quote = await poolHelper.getBestQuote({
        tokenAmount: input.amountIn,
        path: routePath,
        slippage: finalization ? 0n : input.slippage,
        exchangeFactory: input.exchangeFactory,
    })

    const adapter = poolHelper.getLotusAdapter(quote.exchangeFactory)
    const dex = poolHelper.getDexData(quote.exchangeFactory)

    const deadline = Math.floor((Date.now() + 1000 * 60) / 1000)

    let buildSwap: (amountToReceive: bigint) => {
        data: Route['data']
        callData: BytesLike
    }

    if (dex.type === 'v2') {
        if (dex.kind === 'aerodrome') {
            const routes = [
                {
                    from: input.tokenIn,
                    to: input.tokenOut,
                    stable: false,
                    factory: quote.exchangeFactory,
                },
            ]
            buildSwap = (amountToReceive) => {
                const data: SwapAeroV2Struct = {
                    amountToSend: input.amountIn,
                    amountToReceive,
                    routes,
                    deadline,
                }
                return {
                    data,
                    callData:
                        AerodromeV2Adapter__factory.createInterface().encodeFunctionData(
                            'executeSwap',
                            [data]
                        ),
                }
            }
        } else {
            buildSwap = (amountToReceive) => {
                const data: SwapV2Struct = {
                    amountToSend: input.amountIn,
                    amountToReceive,
                    path: routePath,
                    deadline,
                }
                return {
                    data,
                    callData:
                        UniswapV2Adapter__factory.createInterface().encodeFunctionData(
                            'executeSwap',
                            [data]
                        ),
                }
            }
        }
    } else {
        // V3 path encoding is identical for Uniswap V3, PancakeSwap V3, and
        // Aerodrome Slipstream — Aerodrome reuses the SwapV3 struct and
        // encodes `tickSpacing` into the same uint24 slot as Uniswap's `fee`.
        const tier: FeeTier = (quote.feeTier as FeeTier) || feeTier
        const path = solidityPacked(
            ['address', 'uint24', 'address'],
            [input.tokenIn, tier, input.tokenOut]
        )
        buildSwap = (amountToReceive) => {
            const data: SwapV3Struct = {
                amountToSend: input.amountIn,
                amountToReceive,
                path,
                deadline,
            }
            return {
                data,
                callData:
                    UniswapV3Adapter__factory.createInterface().encodeFunctionData(
                        'executeSwap',
                        [data]
                    ),
            }
        }
    }

    let finalized = {
        ...buildSwap(quote.amount),
        finalTollAmount: quote.swapFee,
        effectiveSlippageBps: undefined as string | undefined,
    }

    if (finalization) {
        const context: SwapSimulationContext = {
            chainId: poolHelper.chainId,
            blockNumber: finalization.blockNumber,
            controller: finalization.controller,
            vault: finalization.vault,
            adapter,
            account: finalization.account,
            path:
                dex.type === 'v2'
                    ? routePath
                    : [
                          {
                              tokenIn: input.tokenIn,
                              tokenOut: input.tokenOut,
                              fee: String(quote.feeTier || feeTier),
                          },
                      ],
            buildCallDataForAmount: (amountToReceive) =>
                String(buildSwap(amountToReceive).callData),
            simulator: finalization.simulator,
            prefixTxs: finalization.prefixTxs,
        }
        const result = await finalizeRouteQuote({
            context,
            amountToSend: input.amountIn,
            amountQuoted: quote.amount,
            initialTollAmount: wethIn ? quote.swapFee : 0n,
            maxSlippageE3: finalization.maxSlippageE3 ?? input.slippage,
        })
        finalized = {
            ...buildSwap(result.finalAmountToReceive),
            finalTollAmount: result.finalTollAmount,
            effectiveSlippageBps: result.effectiveSlippageBps,
        }
    }

    return {
        adapter,
        data: finalized.data,
        callData: finalized.callData,
        toll: {
            currency: weth,
            amount: finalized.finalTollAmount,
        },
        hops: routePath.length - 1,
        effectiveSlippageBps: finalized.effectiveSlippageBps,
    }
}
