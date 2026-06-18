import { Contract, type Provider } from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolAddresses,
} from '../addresses'
import { TOLL_DIVISOR_20BPS } from '../constants'
import { FundVault__factory, UniswapV4Adapter__factory } from '../typechain'
import type { SwapV4Struct } from '../typechain/out/UniswapV4Adapter'
import { SWAP_DEADLINE_SECONDS, V4_ZERO_ADDRESS } from './constants'
import { finalizeRouteQuote } from './finalizeRoute'
import { resolveBaseToll } from './helpers'
import type { SwapSimulationContext, SwapSimulator } from './simulation'
import type {
    Route,
    RouteSearchParams,
    SwapV4HookStruct,
    V4HookPathKey,
    V4Path,
    V4PathHop,
} from './types'
import { discoverV4Paths } from './v4PoolDiscovery'

// ─── Minimal V4 Quoter interface ─────────────────────────────────────────────
// The V4 Quoter is not vendored into the SDK typechain (no v4 libs in the EVM
// repo). Only `quoteExactInput` is needed; a minimal ABI keeps the call shape
// explicit. Reverting candidates (nonexistent pools, no liquidity) are simply
// dropped by the allSettled scan.

const V4_QUOTER_ABI = [
    'function quoteExactInput((address exactCurrency, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 exactAmount) params) external returns (uint256 amountOut, uint256 gasEstimate)',
] as const

const V4_HOOK_ADAPTER_ABI = [
    'function executeSwap((uint256 amountToSend,uint256 amountToReceive,address currencyIn,address currencyOut,(address inputCurrency,address intermediateCurrency,uint24 fee,int24 tickSpacing,address hook,bytes hookData)[] path,uint256 deadline) swap) returns ((address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut) trade)',
] as const

const V4_HOOK_LOCKED_SELECTOR = '0x0f2e5b6c'

export interface V4QuoterLike {
    quoteExactInput: {
        staticCall: (params: {
            exactCurrency: string
            path: SwapV4Struct['path']
            exactAmount: bigint
        }) => Promise<[bigint, bigint]>
    }
}

export function connectV4Quoter(
    address: string,
    provider: Provider
): V4QuoterLike {
    return new Contract(
        address,
        V4_QUOTER_ABI,
        provider
    ) as unknown as V4QuoterLike
}

/** Converts an SDK V4 path to the adapter's `PathKey[]` encoding. */
export function toAdapterPathKeys(path: V4Path): SwapV4Struct['path'] {
    return path.map((hop: V4PathHop) => ({
        intermediateCurrency: hop.tokenOut,
        fee: hop.fee,
        tickSpacing: hop.tickSpacing,
        hooks: hop.hooks,
        hookData: hop.hookData,
    }))
}

type V4QuoteSource = 'quoter' | 'adapter-preview'

interface V4Quote {
    path: V4Path
    amountToReceive: bigint
    source: V4QuoteSource
    adapter?: string
}

function isV4HookLockedError(reason: unknown): boolean {
    const seen = new Set<object>()
    const stack: unknown[] = [reason]

    while (stack.length > 0) {
        const current = stack.pop()
        if (
            typeof current === 'string' &&
            current.toLowerCase().includes(V4_HOOK_LOCKED_SELECTOR)
        ) {
            return true
        }
        if (typeof current !== 'object' || current === null) continue
        if (seen.has(current)) continue
        seen.add(current)

        for (const key of Object.getOwnPropertyNames(current)) {
            stack.push((current as Record<string, unknown>)[key])
        }
    }

    return false
}

export interface ApplyV4TollParams {
    baseToll: { currency: string; amount: bigint }
    quotedAmountToReceive: bigint
    quoteSource: V4QuoteSource
    swapAmountIn: bigint
}

export interface ApplyV4TollResult {
    toll: { currency: string; amount: bigint }
    amountQuoted: bigint
    amountToSend: bigint
    initialTollAmount: bigint
}

export function applyV4Toll({
    baseToll,
    quotedAmountToReceive,
    quoteSource,
    swapAmountIn,
}: ApplyV4TollParams): ApplyV4TollResult {
    const toll = { ...baseToll }
    let amountQuoted = quotedAmountToReceive
    let amountToSend = swapAmountIn
    let initialTollAmount = toll.amount

    if (toll.amount === 0n) {
        if (quoteSource === 'quoter') {
            toll.amount = quotedAmountToReceive / TOLL_DIVISOR_20BPS
            amountQuoted -= toll.amount
        }
        // Adapter previews already return Trade.amountOut, which is net of any
        // output-side toll. Keep initialTollAmount at 0 so finalization derives
        // the displayed toll from the chosen net floor without double-counting.
        initialTollAmount = 0n
    } else {
        amountToSend += toll.amount
    }

    return { toll, amountQuoted, amountToSend, initialTollAmount }
}

interface PreviewV4AdapterOutputParams {
    provider: Provider
    controller: string
    vault: string
    adapter: string
    tokenIn: string
    amountToSend: bigint
    path: V4Path
    deadline: number
}

async function previewV4AdapterOutput({
    provider,
    controller,
    vault,
    adapter,
    tokenIn,
    amountToSend,
    path,
    deadline,
}: PreviewV4AdapterOutputParams): Promise<bigint> {
    const adapterIface = UniswapV4Adapter__factory.createInterface()
    const vaultIface = FundVault__factory.createInterface()
    const swapCallData = adapterIface.encodeFunctionData('executeSwap', [
        {
            amountToSend,
            amountToReceive: 0n,
            currencyIn: tokenIn,
            path: toAdapterPathKeys(path),
            deadline,
        } satisfies SwapV4Struct,
    ])
    const vaultCallData = vaultIface.encodeFunctionData('execute', [
        adapter,
        swapCallData,
    ])
    const encodedReturn = await provider.call({
        from: controller,
        to: vault,
        data: vaultCallData,
    })
    const [adapterReturn] = vaultIface.decodeFunctionResult(
        'execute',
        encodedReturn
    )
    const [trade] = adapterIface.decodeFunctionResult(
        'executeSwap',
        adapterReturn
    )
    return BigInt(trade.amountOut)
}

export function toHookAdapterPathKeys(path: V4Path): V4HookPathKey[] {
    return path.map((hop) => ({
        inputCurrency: hop.tokenIn,
        intermediateCurrency: hop.tokenOut,
        fee: hop.fee,
        tickSpacing: hop.tickSpacing,
        hook: hop.hooks,
        hookData: hop.hookData,
    }))
}

function resolveHookCurrencyOut(tokenOut: string, path: V4Path): string {
    const lastHop = path[path.length - 1]
    if (!lastHop) return tokenOut
    return lastHop.tokenOut === V4_ZERO_ADDRESS ? tokenOut : lastHop.tokenOut
}

function encodeV4HookAdapterSwap(swap: SwapV4HookStruct): string {
    return new Contract(
        V4_ZERO_ADDRESS,
        V4_HOOK_ADAPTER_ABI
    ).interface.encodeFunctionData('executeSwap', [swap])
}

interface PreviewV4HookAdapterOutputParams {
    provider: Provider
    controller: string
    vault: string
    adapter: string
    tokenIn: string
    tokenOut: string
    amountToSend: bigint
    path: V4Path
    deadline: number
}

async function previewV4HookAdapterOutput({
    provider,
    controller,
    vault,
    adapter,
    tokenIn,
    tokenOut,
    amountToSend,
    path,
    deadline,
}: PreviewV4HookAdapterOutputParams): Promise<bigint> {
    const hookAdapterIface = new Contract(
        V4_ZERO_ADDRESS,
        V4_HOOK_ADAPTER_ABI
    ).interface
    const vaultIface = FundVault__factory.createInterface()
    const swap: SwapV4HookStruct = {
        amountToSend,
        amountToReceive: 0n,
        currencyIn: tokenIn,
        currencyOut: resolveHookCurrencyOut(tokenOut, path),
        path: toHookAdapterPathKeys(path),
        deadline,
    }
    const swapCallData = hookAdapterIface.encodeFunctionData('executeSwap', [
        swap,
    ])
    const vaultCallData = vaultIface.encodeFunctionData('execute', [
        adapter,
        swapCallData,
    ])
    const encodedReturn = await provider.call({
        from: controller,
        to: vault,
        data: vaultCallData,
    })
    const [adapterReturn] = vaultIface.decodeFunctionResult(
        'execute',
        encodedReturn
    )
    const [trade] = hookAdapterIface.decodeFunctionResult(
        'executeSwap',
        adapterReturn
    )
    return BigInt(trade.amountOut)
}

async function previewBestV4AdapterQuote(
    params: Omit<PreviewV4AdapterOutputParams, 'path'> & {
        candidates: V4Path[]
    }
): Promise<V4Quote | null> {
    const previews = await Promise.allSettled(
        params.candidates.map((path) =>
            previewV4AdapterOutput({ ...params, path })
        )
    )

    let best: V4Quote | null = null
    previews.forEach((result, i) => {
        if (result.status !== 'fulfilled') return
        const amountToReceive = result.value
        if (amountToReceive === 0n) return
        if (!best || amountToReceive > best.amountToReceive) {
            best = {
                path: params.candidates[i]!,
                amountToReceive,
                source: 'adapter-preview',
            }
        }
    })

    return best
}

async function previewBestV4HookAdapterQuote(
    params: Omit<PreviewV4HookAdapterOutputParams, 'path'> & {
        candidates: V4Path[]
    }
): Promise<V4Quote | null> {
    const previews = await Promise.allSettled(
        params.candidates.map((path) =>
            previewV4HookAdapterOutput({ ...params, path })
        )
    )

    let best: V4Quote | null = null
    let sawLockedHook = false
    let sawHookFailure = false
    previews.forEach((result, i) => {
        if (result.status !== 'fulfilled') {
            sawLockedHook ||= isV4HookLockedError(result.reason)
            sawHookFailure ||= params.candidates[i]!.some(
                (hop) => hop.hooks !== V4_ZERO_ADDRESS
            )
            return
        }
        const amountToReceive = result.value
        if (amountToReceive === 0n) return
        if (!best || amountToReceive > best.amountToReceive) {
            best = {
                path: params.candidates[i]!,
                amountToReceive,
                source: 'adapter-preview',
                adapter: params.adapter,
            }
        }
    })

    if (!best && sawLockedHook) {
        throw new Error('TOKEN_LOCKED_BY_V4_HOOK')
    }
    if (!best && sawHookFailure) {
        throw new Error('UNISWAP_V4_HOOK_ROUTE_REVERTED')
    }

    return best
}

// ─── Route builder ───────────────────────────────────────────────────────────

export interface GetUniswapV4RouteContext {
    provider: Provider
    simulator: SwapSimulator
}

/**
 * Discovery-driven Uniswap V4 route source for pools Velora cannot see.
 *
 * Hookless V4 pools are quoted through the regular Velora pipeline
 * (`SUPPORTED_DEXS` includes `UniswapV4` with the version-6.2 engine). This
 * source runs only after Velora yields no route (see `router/index.ts`): it
 * discovers the pair's direct V4 pools — typically hooked ones like
 * VRTX/USDC, which no aggregator indexes — via a cached Dexscreener listing,
 * resolves their immutable PoolKeys on-chain, quotes them on the V4 Quoter
 * and finalizes the best through the same simulation pipeline as every
 * other route.
 */
export default async function getUniswapV4Route(
    params: RouteSearchParams,
    ctx: GetUniswapV4RouteContext
): Promise<Route> {
    const {
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        slippageE2,
        vault,
        account,
        prefixTxs,
    } = params
    const { provider, simulator } = ctx

    const addresses: GuruProtocolAddresses = getGuruProtocolAddresses(chainId)

    const adapter = addresses.adapters.uniswapV4
    const hookAdapter = addresses.adapters.uniswapV4Hook
    const quoterAddress = addresses.quoters.uniswapV4
    if (!adapter || !quoterAddress) {
        throw new Error(`UniswapV4 not supported on chainId ${chainId}`)
    }

    // Convert E2 (per 10_000) to E3 (per 100_000) for internal use.
    const maxSlippageE3 =
        slippageE2 != null ? BigInt(slippageE2) * 10n : undefined

    const { baseToll, swapAmountIn } = resolveBaseToll(
        addresses,
        tokenIn,
        tokenOut,
        amountIn
    )

    const candidates = await discoverV4Paths(chainId, tokenIn, tokenOut, provider)
    if (candidates.length === 0) {
        throw new Error('NO_UNISWAP_V4_ROUTES_FOUND')
    }

    const quoter = connectV4Quoter(quoterAddress, provider)
    const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS
    const [quotes, blockNumber, controller] = await Promise.all([
        Promise.allSettled(
            candidates.map((path) =>
                quoter.quoteExactInput.staticCall({
                    exactCurrency: tokenIn,
                    path: toAdapterPathKeys(path),
                    exactAmount: swapAmountIn,
                })
            )
        ),
        provider.getBlockNumber(),
        FundVault__factory.connect(vault, provider).controller(),
    ])

    let bestQuote: V4Quote | null = null
    quotes.forEach((result, i) => {
        if (result.status !== 'fulfilled') return
        const [amountOut] = result.value
        if (!bestQuote || amountOut > bestQuote.amountToReceive) {
            bestQuote = {
                path: candidates[i]!,
                amountToReceive: amountOut,
                source: 'quoter',
            }
        }
    })

    if (!bestQuote && !prefixTxs?.length) {
        bestQuote = await previewBestV4AdapterQuote({
            provider,
            controller,
            vault,
            adapter,
            tokenIn,
            amountToSend: baseToll.amount === 0n ? swapAmountIn : amountIn,
            deadline,
            candidates,
        })
    }

    if (!bestQuote && hookAdapter && !prefixTxs?.length) {
        bestQuote = await previewBestV4HookAdapterQuote({
            provider,
            controller,
            vault,
            adapter: hookAdapter,
            tokenIn,
            tokenOut,
            amountToSend: baseToll.amount === 0n ? swapAmountIn : amountIn,
            deadline,
            candidates,
        })
    }

    if (!bestQuote || bestQuote.amountToReceive === 0n) {
        throw new Error('NO_UNISWAP_V4_ROUTES_FOUND')
    }

    const selectedAdapter = bestQuote.adapter ?? adapter
    const bestPath = bestQuote.path
    const { toll, amountQuoted, amountToSend, initialTollAmount } = applyV4Toll({
        baseToll,
        quotedAmountToReceive: bestQuote.amountToReceive,
        quoteSource: bestQuote.source,
        swapAmountIn,
    })
    const pathKeys = toAdapterPathKeys(bestPath)
    const hookPathKeys = toHookAdapterPathKeys(bestPath)
    const buildCallDataForAmount = (amountToReceive: bigint) =>
        selectedAdapter === hookAdapter
            ? encodeV4HookAdapterSwap({
                  amountToSend,
                  amountToReceive,
                  currencyIn: tokenIn,
                  currencyOut: resolveHookCurrencyOut(tokenOut, bestPath),
                  path: hookPathKeys,
                  deadline,
              })
            : UniswapV4Adapter__factory.createInterface().encodeFunctionData(
                  'executeSwap',
                  [
                      {
                          amountToSend,
                          amountToReceive,
                          currencyIn: tokenIn,
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
        adapter: selectedAdapter,
        account,
        path: bestPath,
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
        initialTollAmount,
        maxSlippageE3,
    })

    return {
        adapter: selectedAdapter,
        data:
            selectedAdapter === hookAdapter
                ? {
                      amountToSend,
                      amountToReceive: finalAmountToReceive,
                      currencyIn: tokenIn,
                      currencyOut: resolveHookCurrencyOut(
                          tokenOut,
                          bestPath
                      ),
                      path: hookPathKeys,
                      deadline,
                  }
                : {
                      amountToSend,
                      amountToReceive: finalAmountToReceive,
                      currencyIn: tokenIn,
                      path: pathKeys,
                      deadline,
                  },
        callData,
        toll: { ...toll, amount: finalTollAmount },
        hops: bestPath.length,
        effectiveSlippageBps,
    }
}
