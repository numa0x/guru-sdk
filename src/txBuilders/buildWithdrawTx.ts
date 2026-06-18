import type { AddressLike, BytesLike, TransactionRequest } from 'ethers'

import { FundController__factory } from '../typechain'

type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface BuildWithdrawTxParams {
    controller: string
    ledger: string
    coin: string
    shares: bigint
    extCalls: ExternalCallStruct[]
    referrerFeeBps: bigint
    from: string
}

export default function buildWithdrawTx(
    params: BuildWithdrawTxParams
): TransactionRequest {
    const data = FundController__factory.createInterface().encodeFunctionData('withdraw', [
        {
            ledger: params.ledger,
            coin: params.coin,
            shares: params.shares,
            extCalls: params.extCalls,
            referrerFeeBps: params.referrerFeeBps,
        },
    ])
    return {
        to: params.controller,
        from: params.from,
        data,
    }
}
