import { ContractTransactionReceipt, Interface } from 'ethers'

import { TypedContractEvent, TypedLogDescription } from '../typechain/common'

type TypechainOutputObject<T> =
    T extends TypedContractEvent<infer _U, infer _W, infer V>
        ? keyof V extends never
            ? any
            : V
        : any

export default class ReceiptParser {
    /**
     * Creates a new LogParser instance that can be used to find events in a transaction receipt
     * @param receipt The transaction receipt
     */
    constructor(private receipt: ContractTransactionReceipt) {}

    /**
     * Creates a ReceiptParser from Alchemy simulation logs.
     * Normalizes indexed address topics from 20 bytes to 32-byte padded format.
     */
    static fromSimulationLogs(
        logs: { address: string; data: string; topics: string[] }[]
    ) {
        const padded = logs.map((l) => ({
            ...l,
            topics: l.topics.map((t) =>
                t.length < 66 ? '0x' + t.slice(2).padStart(64, '0') : t
            ),
        }))
        return new ReceiptParser({
            logs: padded,
        } as unknown as ContractTransactionReceipt)
    }

    /**
     * Find a specific event among the logs in the transaction receipt
     * @param contractInterface The contract interface to use for parsing the logs
     * @param typedContractEvent The event to find
     * @returns The event arguments
     * @throws Error if the event log is not found
     * @example
     * const { fund, creator } = await new ReceiptParser(receipt).find(
     *   OSHOFund.interface,
     *   OSHOFund.getEvent('Initialized')
     * )
     **/
    getDecodedLog<T extends TypedContractEvent>(
        contractInterface: Interface,
        typedContractEvent: T
    ) {
        for (const log of this.receipt.logs) {
            const parsedLog = contractInterface.parseLog(
                log
            ) as TypedLogDescription<T>

            if (parsedLog?.name === typedContractEvent.name) {
                return parsedLog.args.toObject(true) as TypechainOutputObject<T>
            }
        }

        throw new Error(`Event ${typedContractEvent.name} not found`)
    }

    getDecodedLogAndEmitter<T extends TypedContractEvent>(
        contractInterface: Interface,
        typedContractEvent: T
    ) {
        for (const log of this.receipt.logs) {
            const parsedLog = contractInterface.parseLog(
                log
            ) as TypedLogDescription<T>

            if (parsedLog?.name === typedContractEvent.name) {
                return {
                    emitter: log.address,
                    decodedLog: parsedLog.args.toObject(
                        true
                    ) as TypechainOutputObject<T>,
                }
            }
        }

        throw new Error(`Event ${typedContractEvent.name} not found`)
    }

    /**
     * Return event logs in the transaction receipt
     * @param contractInterface The contract interface to use for parsing the logs
     * @param typedContractEvent The event to find
     * @returns The event logs, can be empty
     * @example
     * const logs = await new ReceiptParser(receipt).getDecodedLogs(
     *   OSHOFund.interface,
     *   OSHOFund.getEvent('Transfer')
     * )
     **/
    getDecodedLogs<T extends TypedContractEvent>(
        contractInterface: Interface,
        typedContractEvent: T
    ) {
        const logs: TypechainOutputObject<T>[] = []
        for (const log of this.receipt.logs) {
            const parsedLog = contractInterface.parseLog(
                log
            ) as TypedLogDescription<T>

            if (parsedLog?.name === typedContractEvent.name) {
                logs.push(
                    parsedLog.args.toObject(true) as TypechainOutputObject<T>
                )
            }
        }

        return logs
    }

    getDecodedLogsAndEmitters<T extends TypedContractEvent>(
        contractInterface: Interface,
        typedContractEvent: T
    ) {
        const logs: {
            emitter: string
            decodedLog: TypechainOutputObject<T>
        }[] = []
        for (const log of this.receipt.logs) {
            const parsedLog = contractInterface.parseLog(
                log
            ) as TypedLogDescription<T>
            if (parsedLog?.name === typedContractEvent.name) {
                logs.push({
                    emitter: log.address,
                    decodedLog: parsedLog.args.toObject(
                        true
                    ) as TypechainOutputObject<T>,
                })
            }
        }
        return logs
    }
}
