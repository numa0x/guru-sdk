import { z } from 'zod'
import { slippageSettingsRecord } from './primitives'

export const quoteCloseSchema = z.object({
    ledger: z.string(),
    coin: z.string(),
    slippageSettings: slippageSettingsRecord(),
})
