import { z } from 'zod'

import { bigNumberish, slippageSettingsRecord } from './primitives'

export const quoteRebalanceSchema = z.object({
    ledger: z.string(),
    targetWeights: z.array(
        z.object({
            token: z.string(),
            weight: bigNumberish(),
        })
    ),
    slippageSettings: slippageSettingsRecord(),
})
