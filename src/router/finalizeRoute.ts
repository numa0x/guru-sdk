import { INITIAL_SLIPPAGE_E3, MAX_EFFECTIVE_SLIPPAGE_BPS } from './constants'
import { withSlippageTolerance } from './helpers'
import {
    findMaxPassingAmountToReceive,
    type SwapSimulationContext,
} from './simulation'

export interface FinalizeRouteQuoteParams {
    context: SwapSimulationContext
    /** Amount encoded as `amountToSend`; includes input toll when toll is input-side. */
    amountToSend: bigint
    /** Net amount before slippage, in the same terms enforced by adapter `amountToReceive`. */
    amountQuoted: bigint
    /**
     * Fixed toll for input-toll routes. Pass 0n for output-toll routes so the
     * final toll is derived from the finalized net min-out.
     */
    initialTollAmount: bigint
    /** Output-side toll rate in e3 form (200 = 0.2%). Defaults to 20 bps. */
    outputTollE3?: bigint
    /** Optional caller-provided max slippage (E3: per 100_000). */
    maxSlippageE3?: bigint
}

export interface FinalizeRouteQuoteResult {
    finalAmountToReceive: bigint
    callData: string
    effectiveSlippageBps: string
    finalTollAmount: bigint
}

export async function finalizeRouteQuote({
    context,
    amountToSend,
    amountQuoted,
    initialTollAmount,
    outputTollE3 = 200n,
    maxSlippageE3,
}: FinalizeRouteQuoteParams): Promise<FinalizeRouteQuoteResult> {
    const amountWithSlippage = withSlippageTolerance(
        amountQuoted,
        INITIAL_SLIPPAGE_E3
    )

    const finalAmountToReceive = await findMaxPassingAmountToReceive({
        ...context,
        amountQuoted,
        amountWithSlippage,
        amountIn: amountToSend,
        maxSlippageE3,
    })

    const finalTollAmount =
        initialTollAmount === 0n
            ? (finalAmountToReceive * outputTollE3) / 100_000n
            : initialTollAmount

    const rawBps =
        finalAmountToReceive > 0n
            ? ((amountQuoted - finalAmountToReceive) * 10_000n) /
              finalAmountToReceive
            : 0n
    const effectiveSlippageBps = (
        rawBps > MAX_EFFECTIVE_SLIPPAGE_BPS
            ? MAX_EFFECTIVE_SLIPPAGE_BPS
            : rawBps
    ).toString()

    return {
        finalAmountToReceive,
        callData: context.buildCallDataForAmount(finalAmountToReceive),
        effectiveSlippageBps,
        finalTollAmount,
    }
}
