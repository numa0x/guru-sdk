import { z } from 'zod'

import { bigNumberish, slippageSettingsRecord } from './primitives'

export const quoteWithdrawalSchema = z.object({
    ledger: z.string(),
    account: z.string(),
    shares: bigNumberish(),
    coin: z.string(),
    referrerFeeBps: bigNumberish(),
    slippageSettings: slippageSettingsRecord(),
})
