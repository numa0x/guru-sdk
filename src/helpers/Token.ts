import { Contract, formatUnits, Interface, type Provider } from 'ethers'

const ERC20_ABI = [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
] as const

export interface TokenMetadata {
    address: string
    decimals: number
    symbol: string
    name: string
}

interface TokenContract {
    decimals(): Promise<bigint>
    symbol(): Promise<string>
    name(): Promise<string>
    balanceOf(account: string): Promise<bigint>
    allowance(owner: string, spender: string): Promise<bigint>
}

export class Token {
    static readonly interface = new Interface(ERC20_ABI)

    static unitFor(decimals: number): bigint {
        return 10n ** BigInt(decimals)
    }

    static format(amount: bigint, decimals: number): string {
        return formatUnits(amount, decimals)
    }

    private readonly contract: TokenContract

    constructor(
        public readonly address: string,
        provider: Provider
    ) {
        this.contract = new Contract(
            address,
            ERC20_ABI as unknown as string[],
            provider
        ) as unknown as TokenContract
    }

    async metadata(): Promise<TokenMetadata> {
        const [decimals, symbol, name] = await Promise.all([
            this.contract.decimals(),
            this.contract.symbol(),
            this.contract.name(),
        ])
        return {
            address: this.address,
            decimals: Number(decimals),
            symbol,
            name,
        }
    }

    balanceOf(account: string): Promise<bigint> {
        return this.contract.balanceOf(account)
    }

    allowance(owner: string, spender: string): Promise<bigint> {
        return this.contract.allowance(owner, spender)
    }
}
