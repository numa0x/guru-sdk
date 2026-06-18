import { z } from 'zod'
import { slippageSettingsRecord } from './primitives'

export const quoteHarvestSchema = z.object({
    ledger: z.string(),
    coin: z.string(),
    isManagementFeeEligible: z.boolean().optional(),
    slippageSettings: slippageSettingsRecord(),
})
