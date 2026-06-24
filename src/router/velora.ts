import { Contract, solidityPacked, type Provider } from 'ethers'

import type { GuruProtocolAddresses, GuruProtocolChainId } from '../addresses'
import { TOLL_DIVISOR_20BPS } from '../constants'
import {
    AerodromeV3Adapter__factory,
    AerodromeV2Adapter__factory,
    IPancakeQuoterV2__factory,
    UniswapV2Adapter__factory,
    UniswapV3Adapter__factory,
    UniswapV4Adapter__factory,
} from '../typechain'
import type { SwapAeroV2Struct } from '../typechain/out/AerodromeV2Adapter'
import type { SwapV2Struct } from '../typechain/out/UniswapV2Adapter'
import type { SwapV3Struct } from '../typechain/out/UniswapV3Adapter'
import type { SwapV4Struct } from '../typechain/out/UniswapV4Adapter'
import { connectV4Quoter, toAdapterPathKeys } from './getUniswapV4Route'
import { SWAP_DEADLINE_SECONDS, type SupportedDex } from './constants'
import { finalizeRouteQuote } from './finalizeRoute'
import {
    type PrefixTx,
    type SwapSimulationContext,
    type SwapSimulator,
} from './simulation'
import type { CachedPath, Route, V3Path } from './types'

// ─── Minimal V2 router interface ─────────────────────────────────────────────
// IUniswapV2Router02 is not vendored into the SDK typechain. Only
// `getAmountsOut` is needed for quoting; a minimal ABI keeps the SDK free of
// extra typechain weight while preserving the call shape used by route-builders.

const V2_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts)',
] as const

const AERO_V2_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) external view returns (uint256[] amounts)',
] as const

const AERO_V3_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
] as const

interface V2RouterLike {
    getAmountsOut: (amountIn: bigint, path: string[]) => Promise<bigint[]>
}

interface AeroV2RouterLike {
    getAmountsOut: (
        amountIn: bigint,
        routes: SwapAeroV2Struct['routes']
    ) => Promise<bigint[]>
}

interface AeroV3QuoterLike {
    quoteExactInputSingle: {
        staticCall: (params: {
            tokenIn: string
            tokenOut: string
            amountIn: bigint
            tickSpacing: bigint
            sqrtPriceLimitX96: bigint
        }) => Promise<{
            amountOut: bigint
            sqrtPriceX96After: bigint
            initializedTicksCrossed: bigint
            gasEstimate: bigint
        }>
    }
}

function connectV2Router(address: string, provider: Provider): V2RouterLike {
    return new Contract(
        address,
        V2_ROUTER_ABI,
        provider
    ) as unknown as V2RouterLike
}

function connectAeroV2Router(
    address: string,
    provider: Provider
): AeroV2RouterLike {
    return new Contract(
        address,
        AERO_V2_ROUTER_ABI,
        provider
    ) as unknown as AeroV2RouterLike
}

function connectAeroV3Quoter(
    address: string,
    provider: Provider
): AeroV3QuoterLike {
    return new Contract(
        address,
        AERO_V3_QUOTER_ABI,
        provider
    ) as unknown as AeroV3QuoterLike
}

// ─── Quoter wiring ───────────────────────────────────────────────────────────
// The Pancake V3 and Uniswap V3 quoters expose an identical `quoteExactInput`
// surface (both implement IQuoterV2 from the v3-periphery interfaces). We reuse
// the vendored IPancakeQuoterV2 typings for both since the call shape is
// byte-identical at the ABI level.

function connectV3Quoter(address: string, provider: Provider) {
    return IPancakeQuoterV2__factory.connect(address, provider)
}

// ─── DEX configuration resolved from SDK address registry ────────────────────

interface V2DexEntry {
    adapter: string
    routerAddress: string
}

interface V3DexEntry {
    adapter: string
    quoterAddress: string
}

interface VeloraDexConfig {
    UniswapV2?: V2DexEntry
    AerodromeV2?: V2DexEntry
    AerodromeV3?: V3DexEntry
    PancakeSwapV2?: V2DexEntry
    UniswapV3?: V3DexEntry
    PancakeSwapV3?: V3DexEntry
    // V4 has no standalone router; the adapter swaps via the Universal Router
    // and quoting goes through the V4 Quoter (same `adapter + quoter` shape).
    UniswapV4?: V3DexEntry
}

export function buildVeloraDexConfig(
    addresses: GuruProtocolAddresses
): VeloraDexConfig {
    const cfg: VeloraDexConfig = {}

    if (addresses.adapters.uniswapV2 && addresses.routers.uniswapV2) {
        cfg.UniswapV2 = {
            adapter: addresses.adapters.uniswapV2,
            routerAddress: addresses.routers.uniswapV2,
        }
    }
    if (addresses.adapters.aerodromeV2 && addresses.routers.aerodromeV2) {
        cfg.AerodromeV2 = {
            adapter: addresses.adapters.aerodromeV2,
            routerAddress: addresses.routers.aerodromeV2,
        }
    }
    if (addresses.adapters.aerodromeV3 && addresses.quoters.aerodromeV3) {
        cfg.AerodromeV3 = {
            adapter: addresses.adapters.aerodromeV3,
            quoterAddress: addresses.quoters.aerodromeV3,
        }
    }
    if (addresses.adapters.pancakeV2 && addresses.routers.pancakeV2) {
        cfg.PancakeSwapV2 = {
            adapter: addresses.adapters.pancakeV2,
            routerAddress: addresses.routers.pancakeV2,
        }
    }
    if (addresses.adapters.uniswapV3 && addresses.quoters.uniswapV3) {
        cfg.UniswapV3 = {
            adapter: addresses.adapters.uniswapV3,
            quoterAddress: addresses.quoters.uniswapV3,
        }
    }
    if (addresses.adapters.pancakeV3 && addresses.quoters.pancakeV3) {
        cfg.PancakeSwapV3 = {
            adapter: addresses.adapters.pancakeV3,
            quoterAddress: addresses.quoters.pancakeV3,
        }
    }
    if (addresses.adapters.uniswapV4 && addresses.quoters.uniswapV4) {
        cfg.UniswapV4 = {
            adapter: addresses.adapters.uniswapV4,
            quoterAddress: addresses.quoters.uniswapV4,
        }
    }

    return cfg
}

/** Whether a DEX is configured (adapter + router/quoter) on this chain. */
export function isDexConfigured(
    addresses: GuruProtocolAddresses,
    dex: SupportedDex
): boolean {
    return Boolean(buildVeloraDexConfig(addresses)[dex])
}

// ─── Path encoding ───────────────────────────────────────────────────────────

function encodeV3Path(path: V3Path): string {
    const pathEncoding: string[] = ['address']
    const pathToEncode: (string | number)[] = [path[0].tokenIn]

    for (const hop of path) {
        pathEncoding.push('uint24', 'address')
        pathToEncode.push(Number(hop.fee), hop.tokenOut)
    }

    return solidityPacked(pathEncoding, pathToEncode)
}

// ─── Route builder ───────────────────────────────────────────────────────────

export interface GetRouteFromPathParams {
    chainId: GuruProtocolChainId
    addresses: GuruProtocolAddresses
    provider: Provider
    simulator: SwapSimulator
    dex: SupportedDex
    cachedPath: CachedPath
    amountIn: bigint
    toll: { currency: string; amount: bigint }
    vault: string
    controller: string
    account: string
    /** Optional caller-provided max slippage (E3: per 100_000). Used as fallback when all simulation candidates fail. */
    maxSlippageE3?: bigint
    /** Optional bundle prefix applied to every simulator call for this leg. */
    prefixTxs?: PrefixTx[]
}

export async function getRouteFromPath({
    chainId,
    addresses,
    provider,
    simulator,
    dex,
    cachedPath,
    amountIn,
    toll,
    vault,
    controller,
    account,
    maxSlippageE3,
    prefixTxs,
}: GetRouteFromPathParams): Promise<Route> {
    if (!cachedPath) {
        throw new Error('No cached path')
    }

    const dexConfig = buildVeloraDexConfig(addresses)

    switch (dex) {
        case 'AerodromeV2': {
            if (cachedPath.type !== 'aerodromeV2') {
                throw new Error('Expected Aerodrome V2 path')
            }

            const entry: V2DexEntry | undefined = dexConfig[dex]
            if (!entry) {
                throw new Error(
                    `DEX ${dex} not supported on chainId ${chainId}`
                )
            }

            const router = connectAeroV2Router(entry.routerAddress, provider)
            const adapter = entry.adapter

            const [grossAmountToReceive, blockNumber] = await Promise.all([
                router
                    .getAmountsOut(amountIn, cachedPath.routes)
                    .then((amounts) => amounts.at(-1)!),
                provider.getBlockNumber(),
            ])

            let amountQuoted = grossAmountToReceive
            let amountToSend = amountIn

            if (toll.amount === 0n) {
                toll.amount = grossAmountToReceive / TOLL_DIVISOR_20BPS
                amountQuoted -= toll.amount
            } else {
                amountToSend += toll.amount
            }

            const deadline =
                Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS
            const buildCallDataForAmount = (amountToReceive: bigint) =>
                AerodromeV2Adapter__factory.createInterface().encodeFunctionData(
                    'executeSwap',
                    [
                        {
                            amountToSend,
                            amountToReceive,
                            routes: cachedPath.routes,
                            deadline,
                        } satisfies SwapAeroV2Struct,
                    ]
                )

            const context: SwapSimulationContext = {
                chainId,
                blockNumber,
                controller,
                vault,
                adapter,
                account,
                path: cachedPath.path,
                buildCallDataForAmount,
                simulator,
                prefixTxs,
            }
            const {
                finalAmountToReceive,
                callData,
                effectiveSlippageBps,
                finalTollAmount,
            } = await finalizeRouteQuote({
                context,
                amountToSend,
                amountQuoted,
                initialTollAmount: toll.amount,
                maxSlippageE3,
            })

            return {
                adapter,
                data: {
                    amountToSend,
                    amountToReceive: finalAmountToReceive,
                    routes: cachedPath.routes,
                    deadline,
                },
                callData,
                toll: { ...toll, amount: finalTollAmount },
                hops: cachedPath.hops,
                effectiveSlippageBps,
            }
        }
        case 'PancakeSwapV2':
        case 'UniswapV2': {
            if (cachedPath.type !== 'v2') {
                throw new Error('Expected V2 path')
            }

            const entry: V2DexEntry | undefined = dexConfig[dex]
            if (!entry) {
                throw new Error(
                    `DEX ${dex} not supported on chainId ${chainId}`
                )
            }

            const router = connectV2Router(entry.routerAddress, provider)
            const adapter = entry.adapter

            const [grossAmountToReceive, blockNumber] = await Promise.all([
                router
                    .getAmountsOut(amountIn, cachedPath.path)
                    .then((amounts) => amounts.at(-1)!),
                provider.getBlockNumber(),
            ])

            // Output toll: adapter deducts toll off router gross and enforces
            // NET >= amountToReceive. Normalise quote + floor to NET here so
            // amounts passed to sim/adapter are apples-to-apples.
            let amountQuoted = grossAmountToReceive
            let amountToSend = amountIn

            if (toll.amount === 0n) {
                toll.amount = grossAmountToReceive / TOLL_DIVISOR_20BPS
                amountQuoted -= toll.amount
            } else {
                amountToSend += toll.amount
            }

            const deadline =
                Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS
            const buildCallDataForAmount = (amountToReceive: bigint) =>
                UniswapV2Adapter__factory.createInterface().encodeFunctionData(
                    'executeSwap',
                    [
                        {
                            amountToSend,
                            amountToReceive,
                            path: cachedPath.path,
                            deadline,
                        } satisfies SwapV2Struct,
                    ]
                )

            const context: SwapSimulationContext = {
                chainId,
                blockNumber,
                controller,
                vault,
                adapter,
                account,
                path: cachedPath.path,
                buildCallDataForAmount,
                simulator,
                prefixTxs,
            }
            const {
                finalAmountToReceive,
                callData,
                effectiveSlippageBps,
                finalTollAmount,
            } = await finalizeRouteQuote({
                context,
                amountToSend,
                amountQuoted,
                initialTollAmount: toll.amount,
                maxSlippageE3,
            })

            return {
                adapter,
                data: {
                    amountToSend,
                    amountToReceive: finalAmountToReceive,
                    path: cachedPath.path,
                    deadline,
                },
                callData,
                toll: { ...toll, amount: finalTollAmount },
                hops: cachedPath.hops,
                effectiveSlippageBps,
            }
        }
        case 'AerodromeV3':
        case 'PancakeSwapV3':
        case 'UniswapV3': {
            if (cachedPath.type !== 'v3') {
                throw new Error('Expected V3 path')
            }

            const entry: V3DexEntry | undefined = dexConfig[dex]
            if (!entry) {
                throw new Error(
                    `DEX ${dex} not supported on chainId ${chainId}`
                )
            }

            const adapter = entry.adapter
            let encodedPath: string
            let grossAmountToReceive: bigint
            let blockNumber: number

            if (dex === 'AerodromeV3') {
                if (cachedPath.path.length !== 1) {
                    throw new Error('Aerodrome V3 multi-hop not supported')
                }
                const [hop] = cachedPath.path
                const tickSpacing = BigInt(hop.fee)
                encodedPath = solidityPacked(
                    ['address', 'uint24', 'address'],
                    [hop.tokenIn, Number(tickSpacing), hop.tokenOut]
                )
                const quoter = connectAeroV3Quoter(
                    entry.quoterAddress,
                    provider
                )
                const [quote, currentBlockNumber] = await Promise.all([
                    quoter.quoteExactInputSingle.staticCall({
                        tokenIn: hop.tokenIn,
                        tokenOut: hop.tokenOut,
                        amountIn,
                        tickSpacing,
                        sqrtPriceLimitX96: 0n,
                    }),
                    provider.getBlockNumber(),
                ])
                grossAmountToReceive = quote.amountOut
                blockNumber = currentBlockNumber
            } else {
                const quoter = connectV3Quoter(entry.quoterAddress, provider)
                encodedPath = encodeV3Path(cachedPath.path)
                const [quote, currentBlockNumber] = await Promise.all([
                    quoter.quoteExactInput.staticCall(encodedPath, amountIn),
                    provider.getBlockNumber(),
                ])
                grossAmountToReceive = quote.amountOut
                blockNumber = currentBlockNumber
            }

            let amountQuoted = grossAmountToReceive
            let amountToSend = amountIn

            if (toll.amount === 0n) {
                toll.amount = grossAmountToReceive / TOLL_DIVISOR_20BPS
                amountQuoted -= toll.amount
            } else {
                amountToSend += toll.amount
            }

            const deadline =
                Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS
            const swapInterface =
                dex === 'AerodromeV3'
                    ? AerodromeV3Adapter__factory.createInterface()
                    : UniswapV3Adapter__factory.createInterface()
            const buildCallDataForAmount = (amountToReceive: bigint) =>
                swapInterface.encodeFunctionData('executeSwap', [
                    {
                        amountToSend,
                        amountToReceive,
                        path: encodedPath,
                        deadline,
                    } satisfies SwapV3Struct,
                ])

            const context: SwapSimulationContext = {
                chainId,
                blockNumber,
                controller,
                vault,
                adapter,
                account,
                path: cachedPath.path,
                buildCallDataForAmount,
                simulator,
                prefixTxs,
            }
            const {
                finalAmountToReceive,
                callData,
                effectiveSlippageBps,
                finalTollAmount,
            } = await finalizeRouteQuote({
                context,
                amountToSend,
                amountQuoted,
                initialTollAmount: toll.amount,
                maxSlippageE3,
            })

            return {
                adapter,
                data: {
                    amountToSend,
                    amountToReceive: finalAmountToReceive,
                    path: encodedPath,
                    deadline,
                },
                callData,
                toll: { ...toll, amount: finalTollAmount },
                hops: cachedPath.hops,
                effectiveSlippageBps,
            }
        }
        case 'UniswapV4': {
            if (cachedPath.type !== 'v4') {
                throw new Error('Expected V4 path')
            }

            const entry: V3DexEntry | undefined = dexConfig[dex]
            if (!entry) {
                throw new Error(
                    `DEX ${dex} not supported on chainId ${chainId}`
                )
            }

            const adapter = entry.adapter
            const quoter = connectV4Quoter(entry.quoterAddress, provider)
            const pathKeys = toAdapterPathKeys(cachedPath.path)
            const currencyIn = cachedPath.path[0].tokenIn

            const [[grossAmountToReceive], blockNumber] = await Promise.all([
                quoter.quoteExactInput.staticCall({
                    exactCurrency: currencyIn,
                    path: pathKeys,
                    exactAmount: amountIn,
                }),
                provider.getBlockNumber(),
            ])

            let amountQuoted = grossAmountToReceive
            let amountToSend = amountIn

            if (toll.amount === 0n) {
                toll.amount = grossAmountToReceive / TOLL_DIVISOR_20BPS
                amountQuoted -= toll.amount
            } else {
                amountToSend += toll.amount
            }

            const deadline =
                Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS
            const buildCallDataForAmount = (amountToReceive: bigint) =>
                UniswapV4Adapter__factory.createInterface().encodeFunctionData(
                    'executeSwap',
                    [
                        {
                            amountToSend,
                            amountToReceive,
                            currencyIn,
                            path: pathKeys,
                            deadline,
                        } satisfies SwapV4Struct,
                    ]
                )

            const context: SwapSimulationContext = {
                chainId,
                blockNumber,
                controller,
                vault,
                adapter,
                account,
                path: cachedPath.path,
                buildCallDataForAmount,
                simulator,
                prefixTxs,
            }
            const {
                finalAmountToReceive,
                callData,
                effectiveSlippageBps,
                finalTollAmount,
            } = await finalizeRouteQuote({
                context,
                amountToSend,
                amountQuoted,
                initialTollAmount: toll.amount,
                maxSlippageE3,
            })

            return {
                adapter,
                data: {
                    amountToSend,
                    amountToReceive: finalAmountToReceive,
                    currencyIn,
                    path: pathKeys,
                    deadline,
                },
                callData,
                toll: { ...toll, amount: finalTollAmount },
                hops: cachedPath.hops,
                effectiveSlippageBps,
            }
        }
        default:
            throw new Error('INVALID_DEX')
    }
}
