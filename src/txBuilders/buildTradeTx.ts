import type { TransactionRequest } from 'ethers'

import { FundController__factory } from '../typechain'

export interface BuildTradeTxParams {
    controller: string
    ledger: string
    adapter: string
    callData: string
    from: string
}

export default function buildTradeTx(
    params: BuildTradeTxParams
): TransactionRequest {
    const data = FundController__factory.createInterface().encodeFunctionData(
        'executeTrade',
        [params.ledger, params.adapter, params.callData]
    )

    return {
        to: params.controller,
        from: params.from,
        data,
    }
}
