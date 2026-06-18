import type { SwapAeroV2Struct } from '../typechain/out/AerodromeV2Adapter'
import type { SwapV2Struct } from '../typechain/out/UniswapV2Adapter'
import type { SwapV3Struct } from '../typechain/out/UniswapV3Adapter'
import type { SwapV4Struct } from '../typechain/out/UniswapV4Adapter'
import type { GuruProtocolChainId } from '../addresses'
import type { PrefixTx } from './simulation'

export type V2Path = string[]
export type V4PathHop = {
    tokenIn: string
    tokenOut: string
    fee: number
    tickSpacing: number
    hooks: string
    hookData: string
}
export type V4Path = V4PathHop[]

export type V4HookPathKey = {
    inputCurrency: string
    intermediateCurrency: string
    fee: number
    tickSpacing: number
    hook: string
    hookData: string
}

export type SwapV4HookStruct = {
    amountToSend: bigint
    amountToReceive: bigint
    currencyIn: string
    currencyOut: string
    path: V4HookPathKey[]
    deadline: number
}

export type V3PathHop = { tokenIn: string; tokenOut: string; fee: string }
export type V3Path = V3PathHop[]

export type CachedPath =
    | { type: 'v2'; path: V2Path; hops: number }
    | { type: 'v3'; path: V3Path; hops: number }
    | { type: 'v4'; path: V4Path; hops: number }
    | false

export interface RouteSearchParams {
    chainId: GuruProtocolChainId
    tokenIn: string
    tokenInDecimals?: number
    tokenOut: string
    tokenOutDecimals?: number
    amountIn: bigint
    slippageE2?: number
    account: string
    vault: string
    /**
     * Optional simulation bundle prefix. For multi-leg flows like rebalance,
     * pass the vault.execute calls of already-validated earlier legs so this
     * leg's slippage simulation runs on the correct post-prefix vault state.
     */
    prefixTxs?: PrefixTx[]
}

export interface Route {
    adapter: string
    data:
        | SwapV2Struct
        | SwapV3Struct
        | SwapAeroV2Struct
        | SwapV4Struct
        | SwapV4HookStruct
    callData: string | Uint8Array<ArrayBufferLike>
    toll: { currency: string; amount: bigint }
    hops: number
    /** Effective slippage for this route in basis points (100 bps = 1%). Set when route is simulation-validated. */
    effectiveSlippageBps?: string
}

// ─── Velora API response types ────────────────────────────────────────────────

export interface VeloraRouteResponse<TData = unknown> {
    priceRoute: VeloraPriceRoute<TData>
}

export interface VeloraPriceRoute<TData = unknown> {
    blockNumber: number
    network: number
    srcToken: string
    srcDecimals: number
    srcAmount: string
    destToken: string
    destDecimals: number
    destAmount: string
    bestRoute: VeloraBestRoute<TData>[]
    gasCostUSD: string
    gasCost: string
    side: string
    version: string
    contractAddress: string
    tokenTransferProxy: string
    contractMethod: string
}

export interface VeloraBestRoute<TData = unknown> {
    percent: number
    swaps: VeloraSwap<TData>[]
}

export interface VeloraSwap<TData = unknown> {
    srcToken: string
    srcDecimals: number
    destToken: string
    destDecimals: number
    swapExchanges: VeloraSwapExchange<TData>[]
}

export interface VeloraSwapExchange<TData = unknown> {
    exchange: string
    srcAmount: string
    destAmount: string
    percent: number
    poolAddresses: string[]
    poolIdentifiers: string[]
    data: TData
}

export interface VeloraDataV2 {
    router: string
    path: string[]
    factory: string
    initCode: string
    feeFactor: number
    gasUSD: string
}

export interface VeloraDataV3 {
    path: V3PathHop[]
    gasUSD: string
}

export interface VeloraV4Hop {
    pool: {
        id: string
        key: {
            currency0: string
            currency1: string
            fee: string
            tickSpacing: number
            hooks: string
        }
    }
    tokenIn: string
    tokenOut: string
    zeroForOne: boolean
}

export interface VeloraDataV4 {
    path: VeloraV4Hop[]
    gasUSD?: string
}

export type VeloraRouteResponseV2 = VeloraRouteResponse<VeloraDataV2>
export type VeloraRouteResponseV3 = VeloraRouteResponse<VeloraDataV3>
export type VeloraRouteResponseV4 = VeloraRouteResponse<VeloraDataV4>
