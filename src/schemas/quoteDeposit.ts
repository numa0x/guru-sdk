import { z } from 'zod'

import { bigNumberish, slippageSettingsRecord } from './primitives'

export const quoteDepositSchema = z.object({
    ledger: z.string(),
    account: z.string(),
    coin: z.string(),
    amount: bigNumberish(),
    referrerFeeBps: bigNumberish(),
    slippageSettings: slippageSettingsRecord(),
})
