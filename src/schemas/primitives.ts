import { z } from 'zod'

/**
 * Accepts `bigint`, integer `number`, or integer-as-string. Output is always
 * `bigint`. Lets callers pass stringified bigints (typical wire shape) or
 * native bigints interchangeably at the SDK boundary.
 */
export const bigNumberish = (
    message = 'Must be a bigint, integer number, or integer string'
) =>
    z
        .bigint()
        .or(z.number().int().transform((v) => BigInt(v)))
        .or(
            z
                .string()
                .regex(/^-?\d+$/, { message })
                .transform((v) => BigInt(v))
        )

/**
 * Optional record of token-address → slippage in 1e3 basis points
 * (1000 = 1%). Values pass through {@link bigNumberish} so callers may pass
 * stringified bigints (legacy tRPC shape) or native bigints.
 */
export const slippageSettingsRecord = () =>
    z.record(z.string(), bigNumberish()).optional()
