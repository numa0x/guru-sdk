import { FundVault__factory } from '../typechain'
import {
    BUNDLE_SIMULATION_CANDIDATES,
    MAX_SLIPPAGE_SEARCH_E3,
} from './constants'
import { withSlippageTolerance } from './helpers'
import type { GuruProtocolChainId } from '../addresses'
import type { V2Path, V3Path, V4Path } from './types'

// ─── Public simulator surface ────────────────────────────────────────────────

/**
 * A pre-validated transaction prepended to the simulation bundle. Each prefix
 * tx must commit (run successfully on the simulator) for the candidate's
 * success/failure to be meaningful — if any prefix tx reverts, the simulator
 * implementation must report success=false.
 *
 * Used for multi-leg rebalances where leg N's outcome depends on the vault
 * state produced by legs 0..N-1. The caller builds prefixTxs as the sequence
 * of `vault.execute(adapter, callData)` calls representing already-committed
 * earlier legs.
 */
export interface PrefixTx {
    from: string
    to: string
    callData: string
}

export interface SimulateSwapParams {
    chainId: GuruProtocolChainId
    from: string
    to: string
    callData: string
    blockNumber: number
    account: string
    amountIn: bigint
    tokenIn: string
    prefixTxs?: PrefixTx[]
}

export interface SimulateSwapResult {
    success: boolean
    revertMessage?: string
}

export type SwapSimulator = (
    params: SimulateSwapParams
) => Promise<SimulateSwapResult>

// ─── Vault calldata wrapping ─────────────────────────────────────────────────

/**
 * Encodes vault.execute(adapter, callData) for simulation. On-chain the
 * controller calls this on the vault.
 */
export function encodeVaultExecute(
    adapter: string,
    swapCallData: string
): string {
    return FundVault__factory.createInterface().encodeFunctionData('execute', [
        adapter,
        swapCallData,
    ])
}

// ─── Shared simulation context ───────────────────────────────────────────────

/**
 * The static "who/where/how" context shared by simulateAndFinalise (in
 * velora.ts) and findMaxPassingAmountToReceive.
 */
export interface SwapSimulationContext {
    chainId: GuruProtocolChainId
    blockNumber: number
    controller: string
    vault: string
    adapter: string
    account: string
    path: V3Path | V2Path | V4Path
    buildCallDataForAmount: (amountToReceive: bigint) => string
    simulator: SwapSimulator
    /**
     * Optional bundle prefix: txs that must commit before the candidate runs.
     * Used by rebalance to chain leg N's sim on top of the committed state of
     * legs 0..N-1. Absent for deposit/withdraw (single-leg) flows.
     */
    prefixTxs?: PrefixTx[]
}

export interface FindMaxAmountParams extends SwapSimulationContext {
    amountQuoted: bigint
    amountWithSlippage: bigint
    amountIn: bigint
    /** Optional caller-provided max slippage (E3: per 100_000). Used as fallback when all simulation candidates fail. */
    maxSlippageE3?: bigint
}

// ─── Candidate generation ────────────────────────────────────────────────────

/**
 * Generates evenly spaced candidates from high to low (descending order).
 *
 * Creates a list of amounts to test, starting from the most optimistic (high)
 * down to the most conservative (low). This allows us to find the highest
 * amount that will pass simulation.
 */
function generateCandidates(
    high: bigint,
    low: bigint,
    count: number
): bigint[] {
    const totalRange = high - low
    const numberOfIntervals = BigInt(count - 1)
    const candidates: bigint[] = []

    for (let i = 0; i < count; i++) {
        const stepDown = (totalRange * BigInt(i)) / numberOfIntervals
        const candidate = high - stepDown
        candidates.push(candidate)
    }

    return candidates
}

// ─── Max-passing amount search ───────────────────────────────────────────────

/**
 * Finds the maximum amountToReceive that will pass simulation using one bundle call.
 *
 * Strategy: Generate N evenly-spaced candidates between amountWithSlippage (initial slippage)
 * and the worst-case low bound, ordered descending. Simulate them sequentially and stop
 * after two pass. The second passing amount is used defensively against marginal candidates.
 */
export async function findMaxPassingAmountToReceive({
    chainId,
    blockNumber,
    controller,
    vault,
    adapter,
    buildCallDataForAmount,
    amountQuoted,
    amountWithSlippage,
    path,
    account,
    amountIn,
    maxSlippageE3,
    simulator,
    prefixTxs,
}: FindMaxAmountParams): Promise<bigint> {
    const high = amountWithSlippage
    if (high <= 0n) return amountWithSlippage

    const low =
        withSlippageTolerance(amountQuoted, MAX_SLIPPAGE_SEARCH_E3) || 1n

    const tokenIn = typeof path[0] === 'string' ? path[0] : path[0].tokenIn

    const simulate = (callData: string) =>
        simulator({
            chainId,
            from: controller,
            to: vault,
            callData,
            blockNumber,
            account,
            amountIn,
            tokenIn,
            prefixTxs,
        })

    if (low >= high) {
        const { success } = await simulate(
            encodeVaultExecute(adapter, buildCallDataForAmount(high))
        )
        return success ? high : amountWithSlippage
    }

    const candidates = generateCandidates(
        high,
        low,
        BUNDLE_SIMULATION_CANDIDATES
    )

    const successIndices: number[] = []
    for (const [index, amount] of candidates.entries()) {
        const result = await simulate(
            encodeVaultExecute(adapter, buildCallDataForAmount(amount))
        )
        if (result.success) successIndices.push(index)
        if (successIndices.length === 2) break
    }

    if (successIndices.length === 0) {
        console.warn(
            'Found no successful simulations for executable route quote',
            {
                chainId,
                blockNumber,
                controller,
                vault,
                adapter,
                amountQuoted,
                amountWithSlippage,
                callData: encodeVaultExecute(
                    adapter,
                    buildCallDataForAmount(high)
                ),
                path,
            }
        )
        throw new Error('NO_EXECUTABLE_ROUTE_FOUND')
    }

    // successIndices are ascending (candidates are descending), so [1] = second-highest amount = safer pick
    const [bestIndex, secondBestIndex] = successIndices
    const targetIndex = secondBestIndex ?? bestIndex
    return candidates[targetIndex]
}
