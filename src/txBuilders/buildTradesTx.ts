import type { TransactionRequest } from 'ethers'

import { FundController__factory } from '../typechain'

export interface BuildTradesTxParams {
    controller: string
    ledger: string
    adapters: string[]
    callData: string[]
    from: string
}

export default function buildTradesTx(
    params: BuildTradesTxParams
): TransactionRequest {
    const data = FundController__factory.createInterface().encodeFunctionData(
        'executeTrades',
        [params.ledger, params.adapters, params.callData]
    )

    return {
        to: params.controller,
        from: params.from,
        data,
    }
}
