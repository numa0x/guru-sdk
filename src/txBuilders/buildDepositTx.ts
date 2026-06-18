import type { AddressLike, BytesLike, TransactionRequest } from 'ethers'

import { FundController__factory } from '../typechain'

type ExternalCallStruct = { adapter: AddressLike; callData: BytesLike }

export interface BuildDepositTxParams {
    controller: string
    ledger: string
    coin: string
    amount: bigint
    sharesOutMin: bigint
    extCalls: ExternalCallStruct[]
    referrerFeeBps: bigint
    from: string
}

export default function buildDepositTx(
    params: BuildDepositTxParams
): TransactionRequest {
    const data = FundController__factory.createInterface().encodeFunctionData('deposit', [
        {
            ledger: params.ledger,
            coin: params.coin,
            amount: params.amount,
            sharesOutMin: params.sharesOutMin,
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
