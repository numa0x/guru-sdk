import type { AddressLike, BytesLike, TransactionRequest } from 'ethers'

import { FundController__factory } from '../typechain'

type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface BuildHarvestTxParams {
    controller: string
    ledger: string
    coin: string
    fraction: bigint
    isManagementFeeEligible: boolean
    extCalls: ExternalCallStruct[]
    from: string
}

export default function buildHarvestTx(
    params: BuildHarvestTxParams
): TransactionRequest {
    const data = FundController__factory.createInterface().encodeFunctionData('harvest', [
        {
            ledger: params.ledger,
            coin: params.coin,
            fraction: params.fraction,
            isManagementFeeEligible: params.isManagementFeeEligible,
            extCalls: params.extCalls,
        },
    ])
    return {
        to: params.controller,
        from: params.from,
        data,
    }
}
