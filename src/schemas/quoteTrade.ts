import { z } from 'zod'

import { bigNumberish } from './primitives'

export const quoteTradeSchema = z.object({
    ledger: z.string(),
    tokenIn: z.string(),
    tokenOut: z.string(),
    amountIn: bigNumberish(),
    maxSlippage: bigNumberish().optional(),
})
