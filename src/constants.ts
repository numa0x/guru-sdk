export const DEFAULT_MANAGER_FEE_RATIO = BigInt(0.1e18) // 10%
/**
 * @dev Divide by these divisors to get the fee rate
 * e.g.: amount / DIVISOR = fee rate of amount
 */
export const TOLL_DIVISOR_20BPS = 500n // 0.2%
export const TOLL_DIVISOR_30BPS = 333n // 0.3%
export const TOLL_DIVISOR_40BPS = 250n // 0.4%
export const TOLL_DIVISOR_50BPS = 200n // 0.5%

export const DEPOSIT_FEE_DIVISOR = 100n // 1%
export const DEPOSIT_DISCOUNTED_FEE_DIVISOR = 200n // 0.5%

/**
 * @dev Share-inflation management fee: rate = f% yearly, compounded every second
 * and withdrawable with a 30 days cooldown
 * @dev Fee formula:
 * => shares * f * seconds / oneHundred * secondsPerYear
 * => shares * f * seconds / (100 * secondsPerYear)
 * => shares * seconds / (100 * 31_536_000 / f)
 * => shares * seconds / divisor --> divisor = MANAGEMENT_FEE_DIVISOR_NUMERATOR / f
 */
export const SECONDS_PER_YEAR = 31_536_000n // 365 days * 24 hours * 60 minutes * 60 seconds
export const MAX_BPS = 10000n // 100%
export const MANAGEMENT_FEE_DIVISOR_NUMERATOR = 100n * SECONDS_PER_YEAR
export const MANAGEMENT_FEE_DIVISOR_2 = 1_576_800_000n // f = 2 -> (100 * 31_536_000 / 2) = 1,576,800,000
export const MANAGEMENT_FEE_DIVISOR_3 = 1_051_200_000n // f = 3 -> (100 * 31_536_000 / 3) = 1,051,200,000
export const MANAGEMENT_FEE_DIVISOR_4 = 788_400_000n // f = 4 -> (100 * 31_536_000 / 4) = 788,400,000

export enum ManagementFee {
    TWO_PERCENT,
    THREE_PERCENT,
    FOUR_PERCENT,
}

export const MANAGEMENT_FEE_COOLDOWN_DAYS = 30n

/**
 * Management fee is eligible if governance token weight >= 5% (5e16 in 1e18 basis)
 */
export const MANAGEMENT_FEE_ELIGIBLE_GOVERNANCE_TOKEN_RATIO = BigInt(0.05e18)
export const GURU_TOKEN_MAINNET = '0xaa7d24c3e14491abac746a98751a4883e9b70843'

export const UNIT = BigInt(1e18)
