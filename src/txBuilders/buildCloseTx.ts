import type { AddressLike, BytesLike, TransactionRequest } from 'ethers'

import { FundController__factory } from '../typechain'

type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface BuildCloseTxParams {
    controller: string
    ledger: string
    coin: string
    extCalls: ExternalCallStruct[]
    from: string
}

export default function buildCloseTx(
    params: BuildCloseTxParams
): TransactionRequest {
    const data = FundController__factory.createInterface().encodeFunctionData(
        'closeFund',
        [
            {
                ledger: params.ledger,
                coin: params.coin,
                extCalls: params.extCalls,
            },
        ]
    )
    return {
        to: params.controller,
        from: params.from,
        data,
    }
}
