import {
    ZeroAddress,
    type AddressLike,
    type BytesLike,
    type Provider,
    type TransactionRequest,
} from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolChainId,
} from '../addresses'
import compareAddresses from '../helpers/compareAddresses'
import FundDataFetcher, { type GetPriceUsd1e18 } from '../helpers/FundDataFetcher'
import { getRouteOut, type RouterContext } from '../router'
import { stablecoinAddresses } from '../router/helpers'
import { quoteCloseSchema } from '../schemas/quoteClose'
import buildCloseTx from '../txBuilders/buildCloseTx'
import { FundLedger__factory } from '../typechain'

export type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface QuoteCloseParams {
    ledger: string
    coin: string
    slippageSettings?: Record<string, bigint>
}

export interface QuoteCloseContext extends RouterContext {
    chainId: GuruProtocolChainId
    getPriceUsd1e18: GetPriceUsd1e18
}

export interface QuoteCloseResult {
    extCalls: ExternalCallStruct[]
    txData: TransactionRequest
}

const slippageE2For = (
    settings: QuoteCloseParams['slippageSettings'],
    token: string
): number | undefined => {
    const slippage = settings?.[token.toLowerCase()]
    return slippage == null ? undefined : Number(slippage / 10n)
}

export default async function quoteClose(
    params: QuoteCloseParams,
    ctx: QuoteCloseContext
): Promise<QuoteCloseResult> {
    const parsed = quoteCloseSchema.parse(params)

    const addresses = getGuruProtocolAddresses(ctx.chainId)
    const isStablecoin = stablecoinAddresses(addresses).some((stable) =>
        compareAddresses(parsed.coin, stable)
    )
    if (!isStablecoin) {
        throw new Error(
            `[@guru-fund/sdk] quoteClose: coin ${parsed.coin} is not a supported stablecoin on chainId ${ctx.chainId}`
        )
    }

    const provider: Provider = ctx.provider
    const ledger = FundLedger__factory.connect(parsed.ledger, provider)
    const fetcher = new FundDataFetcher({
        chainId: ctx.chainId,
        provider,
        getPriceUsd1e18: ctx.getPriceUsd1e18,
    })

    const [fundData, vault, manager, controllerAddress] = await Promise.all([
        fetcher.fetchFundData(ledger),
        ledger.vault(),
        ledger.manager(),
        ledger.controller(),
    ])

    const extCalls: ExternalCallStruct[] = await Promise.all(
        fundData.assets.map(async (asset) => {
            if (compareAddresses(asset.token.address, parsed.coin)) {
                return { adapter: ZeroAddress, callData: '0x' }
            }
            const route = await getRouteOut(
                {
                    chainId: ctx.chainId,
                    tokenIn: asset.token.address,
                    tokenOut: parsed.coin,
                    amountIn: asset.balance,
                    slippageE2: slippageE2For(
                        parsed.slippageSettings,
                        asset.token.address
                    ),
                    account: vault,
                    vault,
                },
                ctx
            )
            return { adapter: route.adapter, callData: route.callData }
        })
    )

    const txData = buildCloseTx({
        controller: controllerAddress,
        ledger: parsed.ledger,
        coin: parsed.coin,
        extCalls,
        from: manager,
    })

    return { extCalls, txData }
}
