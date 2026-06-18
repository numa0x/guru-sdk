import type { GuruProtocolAddresses } from '../addresses'
import { TOLL_DIVISOR_20BPS } from '../constants'
import compareAddresses from '../helpers/compareAddresses'

const PERCENTAGE_DENOMINATOR = 100_000n

/**
 * Returns `amount - (amount * slippage / 100_000)`.
 *
 * Slippage is expressed in E3 (per 100_000), so 500 = 0.5%, 8000 = 8%.
 */
export function withSlippageTolerance(
    amount: bigint,
    slippage: bigint
): bigint {
    const tolerance = (amount * slippage) / PERCENTAGE_DENOMINATOR
    return amount - tolerance
}

export interface BaseTollContext {
    tollIn: boolean
    baseToll: { currency: string; amount: bigint }
    /** Amount actually sent into the swap (input toll already deducted). */
    swapAmountIn: bigint
}

/**
 * Resolves which side of a swap carries the protocol toll and pre-deducts the
 * input-side toll. Throws `INVALID_SWAP` when neither endpoint is tollable —
 * mirrors the adapters' on-chain check. Shared by the Velora and Uniswap V4
 * route sources.
 */
export function resolveBaseToll(
    addresses: GuruProtocolAddresses,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
): BaseTollContext {
    // Toll currency must be either WETH or a stablecoin we recognise on-chain.
    const tollableTokens = [
        addresses.tokens.USDC.toLowerCase(),
        addresses.tokens.USDT.toLowerCase(),
        addresses.tokens.WETH.toLowerCase(),
    ]

    const tollIn = tollableTokens.some((token) =>
        compareAddresses(token, tokenIn)
    )
    const tollOut =
        !tollIn &&
        tollableTokens.some((token) => compareAddresses(token, tokenOut))

    if (!tollIn && !tollOut) {
        throw new Error('INVALID_SWAP')
    }

    let swapAmountIn = amountIn
    const baseToll = {
        currency: tollIn ? tokenIn : tokenOut,
        amount: 0n,
    }

    if (tollIn) {
        baseToll.amount = amountIn / TOLL_DIVISOR_20BPS
        swapAmountIn = amountIn - baseToll.amount
    }

    return { tollIn, baseToll, swapAmountIn }
}
