import { Provider } from 'ethers'

import { UNIT } from '../constants'
import { Fund } from '../types/Fund'
import { Token } from './Token'

export interface FundLedgerReadMethods {
    balanceOf(account: string): Promise<bigint>
    decimals(): Promise<bigint>
    epochFeePerShare(price: bigint): Promise<bigint>
    getAssets(): Promise<string[]>
    totalSupply(): Promise<bigint>
    vault(): Promise<string>
}

export type GetPriceUsd1e18 = (token: string) => Promise<bigint>

export type FundDataFetcherConfig = {
    chainId: number
    provider: Provider
    getPriceUsd1e18: GetPriceUsd1e18
}

export const WEIGHT_DENOMINATOR = 100_000n

export default class FundDataFetcher {
    private provider: Provider
    private getPriceUsd1e18: GetPriceUsd1e18

    constructor(config: FundDataFetcherConfig) {
        this.provider = config.provider
        this.getPriceUsd1e18 = config.getPriceUsd1e18
    }

    public async getUserTvlShare(
        ledger: FundLedgerReadMethods,
        account: string,
        tokenValue: bigint
    ): Promise<bigint> {
        const [userBalance, decimals] = await Promise.all([
            ledger.balanceOf(account),
            ledger.decimals(),
        ])
        const unit = 10n ** decimals
        return (userBalance * tokenValue) / unit
    }

    public async fetchFundData(ledger: FundLedgerReadMethods): Promise<Fund.Overview> {
        const [vault, assetAddresses, tokenTotalSupply] = await Promise.all([
            ledger.vault(),
            ledger.getAssets().then((a: string[]) => a.map((a) => a.toLowerCase())),
            ledger.totalSupply(),
        ])

        const mapAssetValue = <T>(values: T[]) =>
            Object.fromEntries(
                values.map((value, index) => [assetAddresses[index], value])
            )

        const [tokensByAddress, balancesByAddress, pricesByAddress] =
            await Promise.all([
                Promise.all(
                    assetAddresses.map((address) =>
                        new Token(address, this.provider).metadata()
                    )
                ).then(mapAssetValue),
                Promise.all(
                    assetAddresses.map((address) =>
                        new Token(address, this.provider).balanceOf(vault)
                    )
                ).then(mapAssetValue),
                Promise.all(
                    assetAddresses.map((address) =>
                        this.getPriceUsd1e18(address)
                    )
                ).then(mapAssetValue),
            ])

        const assets: (Fund.Asset & { totalUsd1e18Value: bigint })[] =
            assetAddresses.map((address, index) => {
                const token = tokensByAddress[address]
                const balance = balancesByAddress[address]
                const usd1e18Price = pricesByAddress[address]
                const totalUsd1e18Value =
                    (usd1e18Price * balance) / Token.unitFor(token.decimals)

                return {
                    index,
                    token,
                    balance,
                    usd1e18Price,
                    totalUsd1e18Value,
                    weight: 0n,
                    depositWeight: 0n,
                }
            })

        const totalValueLocked = assets.reduce(
            (total, asset) => total + asset.totalUsd1e18Value,
            0n
        )
        const tokenPrice =
            tokenTotalSupply === 0n
                ? 0n
                : (totalValueLocked * UNIT) / tokenTotalSupply
        const tokenValue =
            tokenPrice - (await ledger.epochFeePerShare(tokenPrice))

        const assetsWithWeights: Fund.Asset[] = assets.map(
            ({ totalUsd1e18Value, ...asset }) => ({
                ...asset,
                weight:
                    totalValueLocked === 0n
                        ? 0n
                        : (totalUsd1e18Value * WEIGHT_DENOMINATOR) /
                          totalValueLocked,
            })
        )

        return {
            assets: assetsWithWeights,
            tokenTotalSupply,
            totalValueLocked,
            tokenValue,
            tokenPrice,
        }
    }
}
