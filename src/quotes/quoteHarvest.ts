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
import {
    GURU_TOKEN_MAINNET,
    MANAGEMENT_FEE_COOLDOWN_DAYS,
    MANAGEMENT_FEE_ELIGIBLE_GOVERNANCE_TOKEN_RATIO,
    MAX_BPS,
    UNIT,
} from '../constants'
import compareAddresses from '../helpers/compareAddresses'
import FundDataFetcher, {
    WEIGHT_DENOMINATOR,
    type GetPriceUsd1e18,
} from '../helpers/FundDataFetcher'
import { getRouteOut, type RouterContext } from '../router'
import { stablecoinAddresses } from '../router/helpers'
import { quoteHarvestSchema } from '../schemas/quoteHarvest'
import buildHarvestTx from '../txBuilders/buildHarvestTx'
import { FundLedger__factory, HarvestController__factory } from '../typechain'
import ReceiptParser from '../helpers/ReceiptParser'

export type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface QuoteHarvestParams {
    ledger: string
    /** Stablecoin to harvest into. Must be a stablecoin in `addresses.tokens`. */
    coin: string
    /**
     * Optional override for management fee eligibility. When omitted, the SDK
     * derives eligibility from the current fund weights and governance-token
     * threshold.
     */
    isManagementFeeEligible?: boolean
    /**
     * Optional per-asset max slippage settings (e3, e.g. "500" = 0.5%). Used
     * when harvesting non-stable assets into the requested stablecoin.
     */
    slippageSettings?: Record<string, bigint>
}

export interface QuoteHarvestContext extends RouterContext {
    chainId: GuruProtocolChainId
    /** USD-1e18 price oracle injected into FundDataFetcher. */
    getPriceUsd1e18: GetPriceUsd1e18
}

export interface QuoteHarvestLogs {
    harvestableAmount: bigint
}

export type SimulationLog = {
    address: string
    data: string
    topics: string[]
}

export interface QuoteHarvestResult {
    extCalls: ExternalCallStruct[]
    harvestableFraction: bigint
    managementFee: bigint
    txData: TransactionRequest
    decodeLogs: (logs: SimulationLog[]) => QuoteHarvestLogs | null
}

// totalValueLocked / tokenPrice are tracked in USDT (1e6) units; the on-chain
// fraction is 1e18-based, so we lift to 1e18 with this normalizer.
const NORMALIZER = BigInt(1e12)
const ONE_DAY_IN_MS = 86400n * 1000n
const slippageE2For = (
    settings: QuoteHarvestParams['slippageSettings'],
    token: string
): number | undefined => {
    const slippage = settings?.[token.toLowerCase()]
    return slippage == null ? undefined : Number(slippage / 10n)
}

export default async function quoteHarvest(
    params: QuoteHarvestParams,
    ctx: QuoteHarvestContext
): Promise<QuoteHarvestResult> {
    const parsed = quoteHarvestSchema.parse(params)

    const addresses = getGuruProtocolAddresses(ctx.chainId)
    const isStablecoin = stablecoinAddresses(addresses).some((stable) =>
        compareAddresses(parsed.coin, stable)
    )
    if (!isStablecoin) {
        throw new Error(
            `[@guru-fund/sdk] quoteHarvest: coin ${parsed.coin} is not a supported stablecoin on chainId ${ctx.chainId}`
        )
    }

    const provider: Provider = ctx.provider
    const ledger = FundLedger__factory.connect(parsed.ledger, provider)

    const fetcher = new FundDataFetcher({
        chainId: ctx.chainId,
        provider,
        getPriceUsd1e18: ctx.getPriceUsd1e18,
    })

    const [
        fundData,
        vault,
        manager,
        controllerAddress,
        profitFeeBps,
        totalPrincipal,
        totalVirtualBuffer,
        latestManagementFeeTimestamp,
    ] = await Promise.all([
        fetcher.fetchFundData(ledger),
        ledger.vault(),
        ledger.manager(),
        ledger.controller(),
        ledger.profitFeeBps(),
        ledger.totalPrincipal(),
        ledger.totalVirtualBuffer(),
        ledger.latestManagementFeeTimestamp(),
    ])

    const tvl = fundData.totalValueLocked * NORMALIZER
    const guruWeight1e18 =
        ((fundData.assets.find((asset) =>
            compareAddresses(asset.token.address, GURU_TOKEN_MAINNET)
        )?.weight ?? 0n) *
            UNIT) /
        WEIGHT_DENOMINATOR
    const isManagementFeeEligible =
        parsed.isManagementFeeEligible ??
        guruWeight1e18 >= MANAGEMENT_FEE_ELIGIBLE_GOVERNANCE_TOKEN_RATIO

    const latestManagementFeeMs = Number(latestManagementFeeTimestamp) * 1000
    const nextManagementFeeTimestampMs =
        BigInt(latestManagementFeeMs) +
        ONE_DAY_IN_MS * MANAGEMENT_FEE_COOLDOWN_DAYS

    const ledgerBalance = await ledger.balanceOf(ledger.target as string)
    const managementFee =
        BigInt(Date.now()) >= nextManagementFeeTimestampMs
            ? (fundData.tokenPrice * ledgerBalance) / UNIT
            : 0n

    const feeApplicableAmount = tvl - (totalPrincipal + totalVirtualBuffer)
    const harvestProjection =
        managementFee + (profitFeeBps * feeApplicableAmount) / MAX_BPS

    const harvestableFraction =
        tvl > 0n && harvestProjection > 0n
            ? (harvestProjection * UNIT) / tvl
            : 0n

    const isNoOp = harvestProjection <= 0n && managementFee <= 0n

    // For every fund asset, swap the harvestable fraction into the requested
    // stablecoin. Assets already denominated in `coin` are tagged as no-op
    // calls (matches the legacy `{ adapter: ZeroAddress, callData: '0x' }`).
    const extCalls: ExternalCallStruct[] = isNoOp
        ? []
        : await Promise.all(
              fundData.assets.map(async (asset) => {
                  if (compareAddresses(asset.token.address, parsed.coin)) {
                      return { adapter: ZeroAddress, callData: '0x' }
                  }
                  const route = await getRouteOut(
                      {
                          chainId: ctx.chainId,
                          tokenIn: asset.token.address,
                          tokenOut: parsed.coin,
                          amountIn:
                              (harvestableFraction * asset.balance) / UNIT,
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

    const txData = buildHarvestTx({
        controller: controllerAddress,
        ledger: parsed.ledger,
        coin: parsed.coin,
        fraction: isNoOp ? 0n : harvestableFraction,
        isManagementFeeEligible,
        extCalls,
        from: manager,
    })

    const decodeLogs: QuoteHarvestResult['decodeLogs'] = (logs) => {
        try {
            const parser = ReceiptParser.fromSimulationLogs(logs)
            const controller = HarvestController__factory.connect(
                controllerAddress,
                provider
            )
            const harvested = parser.getDecodedLog(
                controller.interface,
                controller.getEvent('Harvested')
            )
            return { harvestableAmount: harvested.managerFee / NORMALIZER }
        } catch {
            return null
        }
    }

    return {
        extCalls,
        harvestableFraction: isNoOp ? 0n : harvestableFraction,
        managementFee: isNoOp ? 0n : managementFee,
        txData,
        decodeLogs,
    }
}
