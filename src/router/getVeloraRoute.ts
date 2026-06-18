import type { Provider } from 'ethers'

import {
    getGuruProtocolAddresses,
    type GuruProtocolAddresses,
} from '../addresses'
import { Token } from '../helpers/Token'
import { FundVault__factory } from '../typechain'
import { MAX_ROUTE_HOPS, SUPPORTED_DEXS } from './constants'
import { resolveBaseToll } from './helpers'
import type { PathFetcher } from './pathCache'
import type { SwapSimulator } from './simulation'
import type { Route, RouteSearchParams } from './types'
import { getRouteFromPath, isDexConfigured } from './velora'

async function fetchDecimals(
    token: string,
    provider: Provider
): Promise<number> {
    const { decimals } = await new Token(token, provider)
        .metadata()
        .catch(() => ({ decimals: 0 }))
    return decimals
}

export interface GetVeloraRouteContext {
    provider: Provider
    simulator: SwapSimulator
    getPath: PathFetcher
}

/**
 * Velora-backed route discovery for Guru Protocol deposit/withdraw flows.
 *
 * Mirrors `apps/trpc/src/services/get-route/get-velora-route.ts` exactly:
 *   - Fetches a path per DEX (path cache), filters by hop limit
 *   - On-chain quotes each path via `getRouteFromPath`
 *   - Picks the route with the highest `amountToReceive`
 *
 * Throws when no DEX yields a usable path. Callers (`router/index.ts`) catch
 * and fall through to the on-chain PoolHelper-based fallback.
 */
export default async function getVeloraRoute(
    params: RouteSearchParams,
    ctx: GetVeloraRouteContext
): Promise<Route> {
    const {
        chainId,
        tokenIn,
        tokenInDecimals,
        tokenOut,
        tokenOutDecimals,
        amountIn,
        slippageE2,
        vault,
        account,
        prefixTxs,
    } = params
    const { provider, simulator, getPath } = ctx

    const addresses: GuruProtocolAddresses = getGuruProtocolAddresses(chainId)

    // Convert E2 (per 10_000) to E3 (per 100_000) for internal use.
    const maxSlippageE3 =
        slippageE2 != null ? BigInt(slippageE2) * 10n : undefined

    const [srcDecimals, destDecimals, controller] = await Promise.all([
        tokenInDecimals ?? fetchDecimals(tokenIn, provider),
        tokenOutDecimals ?? fetchDecimals(tokenOut, provider),
        FundVault__factory.connect(vault, provider).controller(),
    ])

    const { baseToll, swapAmountIn } = resolveBaseToll(
        addresses,
        tokenIn,
        tokenOut,
        amountIn
    )

    const routes = (
        await Promise.all(
            SUPPORTED_DEXS.map(async (dex) => {
                try {
                    // Skip DEXes with no adapter/quoter on this chain before
                    // spending an HTTP fetch (e.g. UniswapV4 until its adapter
                    // address lands in `addresses.ts`).
                    if (!isDexConfigured(addresses, dex)) return false

                    const cachedPath = await getPath({
                        chainId,
                        dex,
                        tokenIn,
                        tokenOut,
                        srcDecimals: Number(srcDecimals),
                        destDecimals: Number(destDecimals),
                        vault,
                    })

                    if (!cachedPath) return false
                    if (cachedPath.hops > MAX_ROUTE_HOPS) return false

                    const toll = { ...baseToll }

                    return await getRouteFromPath({
                        chainId,
                        addresses,
                        provider,
                        simulator,
                        dex,
                        cachedPath,
                        amountIn: swapAmountIn,
                        toll,
                        vault,
                        controller,
                        account,
                        maxSlippageE3,
                        prefixTxs,
                    })
                } catch {
                    return false
                }
            })
        )
    ).filter((r): r is Route => !!r)

    if (routes.length === 0) {
        throw new Error('NO_VELORA_ROUTES_FOUND')
    }

    return routes.reduce((best, current) =>
        BigInt(best.data.amountToReceive) < BigInt(current.data.amountToReceive)
            ? current
            : best
    )
}
