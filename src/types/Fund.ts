export namespace Fund {
    export interface Overview {
        assets: Asset[]
        /** Total value locked in USD, 1e18 scale */
        totalValueLocked: bigint
        /** Net value of one fund token in USD, 1e18 scale (gross minus epoch fee) */
        tokenValue: bigint
        /** Gross value of one fund token in USD, 1e18 scale (TVL / totalSupply) */
        tokenPrice: bigint
        tokenTotalSupply: bigint
    }

    export interface AssetToken {
        address: string
        decimals: number
        symbol: string
        name: string
    }

    export interface Asset {
        index: number
        token: AssetToken
        balance: bigint
        /** USD price per token unit, 1e18 scale */
        usd1e18Price: bigint
        weight: bigint
        depositWeight: bigint
    }

    export interface AssetWeight {
        assetAddress: string
        weight: bigint
    }
}
