import type { Provider, TransactionRequest } from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolChainId,
} from '../addresses'
import compareAddresses from '../helpers/compareAddresses'
import { getRouteIn, getRouteOut, type RouterContext } from '../router'
import { encodeVaultExecute, type PrefixTx } from '../router/simulation'
import type { Route } from '../router/types'
import { quoteTradeSchema } from '../schemas/quoteTrade'
import buildTradeTx from '../txBuilders/buildTradeTx'
import buildTradesTx from '../txBuilders/buildTradesTx'
import { FundLedger__factory, Protocol__factory } from '../typechain'

export interface QuoteTradeParams {
    ledger: string
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    /**
     * Optional max slippage in e3 form (e.g. 1000n = 1%). Mirrors the legacy
     * tRPC procedure input shape; converted to the router's e2 form via
     * `Number(maxSlippage / 10n)` before being passed to `getRouteIn` /
     * `getRouteOut`. Omit to let the route helper apply its own default.
     */
    maxSlippage?: bigint
}

export interface QuoteTradeContext extends RouterContext {
    chainId: GuruProtocolChainId
}

/**
 * Trades are internal to the fund lifecycle (manager-driven rebalances and
 * one-off swaps). For CLI and agent workflows we still return the
 * pre-encoded controller call as `txData`, so callers can preview and submit
 * a one-off trade without rebuilding the calldata from `Route`.
 */
export interface QuoteTradeResult extends Route {
    routes: Route[]
    txData: TransactionRequest
}

async function buildCompositeWethRoute(
    routeParams: {
        chainId: GuruProtocolChainId
        tokenIn: string
        tokenOut: string
        amountIn: bigint
        slippageE2?: number
        account: string
        vault: string
    },
    weth: string,
    controllerAddress: string,
    vaultAddress: string,
    ctx: QuoteTradeContext
): Promise<Route[]> {
    const first = await getRouteIn({ ...routeParams, tokenOut: weth }, ctx)
    const prefixTxs: PrefixTx[] = [
        {
            from: controllerAddress,
            to: vaultAddress,
            callData: encodeVaultExecute(
                String(first.adapter),
                String(first.callData)
            ),
        },
    ]
    const second = await getRouteIn(
        {
            ...routeParams,
            tokenIn: weth,
            amountIn: BigInt(first.data.amountToReceive),
            prefixTxs,
        },
        ctx
    )
    return [first, second]
}

export async function bestOfDirectAndComposite(
    direct: () => Promise<Route>,
    composite: () => Promise<Route[]>
): Promise<Route[]> {
    const [directResult, compositeResult] = await Promise.allSettled([
        direct(),
        composite(),
    ])

    if (
        directResult.status === 'rejected' &&
        directResult.reason instanceof Error &&
        (directResult.reason.message.includes('TOKEN_LOCKED_BY_V4_HOOK') ||
            directResult.reason.message.includes(
                'UNISWAP_V4_HOOK_ROUTE_REVERTED'
            ))
    ) {
        throw directResult.reason
    }

    if (
        directResult.status === 'fulfilled' &&
        compositeResult.status === 'fulfilled'
    ) {
        const compositeRoute = compositeResult.value.at(-1)!
        return BigInt(directResult.value.data.amountToReceive) >=
            BigInt(compositeRoute.data.amountToReceive)
            ? [directResult.value]
            : compositeResult.value
    }
    if (directResult.status === 'fulfilled') return [directResult.value]
    if (compositeResult.status === 'fulfilled') return compositeResult.value
    throw directResult.reason
}

export default async function quoteTrade(
    params: QuoteTradeParams,
    ctx: QuoteTradeContext
): Promise<QuoteTradeResult> {
    const parsed = quoteTradeSchema.parse(params)

    const provider: Provider = ctx.provider
    const addresses = getGuruProtocolAddresses(ctx.chainId)

    const protocol = Protocol__factory.connect(addresses.protocol, provider)

    // A trade is "toll applicable" on the side that's the wrapped native or a
    // protocol-enabled stablecoin. The router needs to know which side carries
    // the toll so it can route the swap through the correct adapter call
    // (input-toll vs output-toll). At least one side must qualify — otherwise
    // the trade has no protocol-supported anchor.
    const isTollApplicable = async (token: string): Promise<boolean> => {
        return (
            compareAddresses(token, addresses.tokens.WETH) ||
            (await protocol.isEnabledStablecoin(token))
        )
    }

    const [tollIn, tollOut] = await Promise.all([
        isTollApplicable(parsed.tokenIn),
        isTollApplicable(parsed.tokenOut),
    ])

    if (!tollIn && !tollOut) {
        throw new Error(
            `[@guru-fund/sdk] quoteTrade: toll not applicable to ${parsed.tokenIn} ↔ ${parsed.tokenOut}`
        )
    }

    const getRoute = tollIn ? getRouteIn : getRouteOut

    const ledger = FundLedger__factory.connect(parsed.ledger, provider)
    const [vaultAddress, controllerAddress, manager] = await Promise.all([
        ledger.vault(),
        ledger.controller(),
        ledger.manager(),
    ])

    const slippageE2 =
        parsed.maxSlippage != null
            ? Number(parsed.maxSlippage / 10n)
            : undefined
    const routeParams = {
        chainId: ctx.chainId,
        tokenIn: parsed.tokenIn,
        tokenOut: parsed.tokenOut,
        amountIn: parsed.amountIn,
        slippageE2,
        account: vaultAddress,
        vault: vaultAddress,
    } as const

    const weth = addresses.tokens.WETH
    const routes =
        compareAddresses(parsed.tokenIn, weth) ||
        compareAddresses(parsed.tokenOut, weth)
            ? [await getRoute(routeParams, ctx)]
            : await bestOfDirectAndComposite(
                  () => getRoute(routeParams, ctx),
                  () =>
                      buildCompositeWethRoute(
                          routeParams,
                          weth,
                          controllerAddress,
                          vaultAddress,
                          ctx
                      )
              )

    const route = routes.at(-1)!
    const txData =
        routes.length === 1
            ? buildTradeTx({
                  controller: controllerAddress,
                  ledger: parsed.ledger,
                  adapter: String(route.adapter),
                  callData: String(route.callData),
                  from: manager,
              })
            : buildTradesTx({
                  controller: controllerAddress,
                  ledger: parsed.ledger,
                  adapters: routes.map((item) => String(item.adapter)),
                  callData: routes.map((item) => String(item.callData)),
                  from: manager,
              })

    return {
        ...route,
        routes,
        hops: routes.reduce((sum, item) => sum + item.hops, 0),
        txData,
    }
}
