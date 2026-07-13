export type GuruProtocolChainId = 1 | 8453 | 4663

type AdapterKey =
    | 'uniswapV2'
    | 'uniswapV3'
    | 'uniswapV4'
    | 'uniswapV4Hook'
    | 'pancakeV2'
    | 'pancakeV3'
    | 'aerodromeV2'
    | 'aerodromeV3'

type FactoryKey = AdapterKey | 'aerodromeV3Bis'

type RouterKey = AdapterKey

type QuoterKey = 'uniswapV3' | 'uniswapV4' | 'pancakeV3' | 'aerodromeV3'

export type GuruProtocolAddresses = {
    readonly chainId: GuruProtocolChainId

    readonly protocol: string
    readonly vaultImplementation: string
    readonly ledgerImplementation: string

    readonly controllers: Readonly<
        Partial<{
            creation: string
            deposit: string
            withdrawal: string
            closure: string
            harvest: string
            transfer: string
            trade: string
            fund: string
        }>
    >

    readonly adapters: Readonly<Partial<Record<AdapterKey, string>>>
    readonly factories: Readonly<Partial<Record<FactoryKey, string>>>
    readonly routers: Readonly<Partial<Record<RouterKey, string>>>
    readonly quoters: Readonly<Partial<Record<QuoterKey, string>>>
    readonly routeBridges?: readonly string[]

    readonly tokens: Readonly<{
        WETH: string
        USDC: string
        USDT: string
        USDG?: string
    }>

    readonly migrator?: string
}

export class UnsupportedChainError extends Error {
    public readonly chainId: number
    constructor(chainId: number) {
        super(
            `[@guru-fund/sdk] chainId ${chainId} is not supported. Supported chainIds: ${SUPPORTED_CHAIN_IDS.join(', ')}`
        )
        this.name = 'UnsupportedChainError'
        this.chainId = chainId
    }
}

const MAINNET: GuruProtocolAddresses = {
    chainId: 1,

    protocol: '0x63d990618fe7f763b08a47d0295ba06207dc6b38',
    vaultImplementation: '0x7a4087200216198482de0270998a9571813db300',
    ledgerImplementation: '0xe52160f5f90c6bd910c9ef106911185445cdaf15',

    controllers: {
        creation: '0x1eecd3e1832a3a9abb618df8ee1900a6e7101cff',
        deposit: '0x75aa804a208057b5d692cd213d39591a952a2aba',
        withdrawal: '0x15da4363b3729c6f2befebd6f87d84bd8747dcce',
        closure: '0x54ef8309cae3c5b134f864f9a582be8d87e488b3',
        harvest: '0x81d60af23a90101e844fa8c919fb98a0ff1f8787',
        transfer: '0x08377d07e09248a897695cc7286d26a4bf07e02f',
        trade: '0x6912fa7cd7f15bdcab4c5dc5268025fb1b1d6aa8',
        fund: '0xf9357a85e79c388c13fb83b237ff759675cc5977',
    },

    adapters: {
        uniswapV2: '0xa8ddce8dbd35c65cf1de5d3be0df0e34e4c7edc2',
        uniswapV3: '0xefccd55c1c4a471d72f37f84d65361ed708d22d7',
        uniswapV4: '0xc53089118e3e988929a09286f73491bbca174fcb',
        uniswapV4Hook: '0x8f6cba5d0ccda93ffd16b7c367a78f0d1f0fa374',
        pancakeV2: '0x0dd3d063146a53878d25f6463d6347f8cd7a0629',
        pancakeV3: '0x6eaa8a505f5d18563ef6881a4fd7811f4b6b9dca',
    },

    factories: {
        uniswapV2: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
        uniswapV3: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
        pancakeV2: '0x1097053fd2ea711dad45caccc45eff7548fcb362',
        pancakeV3: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    },

    routers: {
        uniswapV2: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        uniswapV3: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
        pancakeV2: '0xeff92a263d31888d860bd50809a8d171709b7b1c',
        pancakeV3: '0x1b81d678ffb9c0263b24a97847620c99d213eb14',
    },

    quoters: {
        uniswapV3: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
        uniswapV4: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
        pancakeV3: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
    },

    tokens: {
        WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    },

    migrator: '0x616397d1e372023b5ac0498eeed2fd9fc9c06a79',
} as const

const BASE: GuruProtocolAddresses = {
    chainId: 8453,

    protocol: '0x7a4087200216198482de0270998a9571813db300',
    vaultImplementation: '0xe52160f5f90c6bd910c9ef106911185445cdaf15',
    ledgerImplementation: '0x1eecd3e1832a3a9abb618df8ee1900a6e7101cff',

    controllers: {
        fund: '0x70451b00c42a73ea2d9707ddc7413aff8620be85',
    },

    adapters: {
        aerodromeV2: '0x581aa0ea01387e1b85d8bc3e14ec3475dee9c334',
        aerodromeV3: '0x3d95d6cf7f41c905ec132020d3a39898a20977ae',
        pancakeV3: '0x2d993c905426994a7dbb7115ca460ef33e384906',
        uniswapV2: '0xefccd55c1c4a471d72f37f84d65361ed708d22d7',
        // SwapRouter02 variant — see `UniswapV3SwapRouter02Adapter`.
        uniswapV3: '0x0dd3d063146a53878d25f6463d6347f8cd7a0629',
        uniswapV4: '0xe227ed4c09003a875432147379c334ce02c4d229',
    },

    factories: {
        aerodromeV2: '0x420dd381b31aef6683db6b902084cb0ffece40da',
        aerodromeV3: '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a',
        aerodromeV3Bis: '0x9592cd9b267748cbfbde90ac9f7df3c437a6d51b',
        uniswapV2: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
        uniswapV3: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
        pancakeV3: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    },

    routers: {
        aerodromeV2: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
        aerodromeV3: '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5',
        uniswapV2: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
        uniswapV3: '0x2626664c2603336e57b271c5c0b26f421741e481',
    },

    quoters: {
        aerodromeV3: '0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0',
        uniswapV3: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
        uniswapV4: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
    },

    tokens: {
        WETH: '0x4200000000000000000000000000000000000006',
        USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        USDT: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
    },

    migrator: '0x209656784c8eb405765288c8f447d11c0aa1a3d3',
} as const

const ROBINHOOD: GuruProtocolAddresses = {
    chainId: 4663,

    protocol: '0xe0d99cd8bf9f091713c88ff763d669ad3703876c',
    vaultImplementation: '0x70451b00c42a73ea2d9707ddc7413aff8620be85',
    ledgerImplementation: '0xa8644a5eb1cf74f0d8c7771d3bca9cb5f4edd6a5',

    controllers: {
        fund: '0x36e2de2f1b66ecaa5fda2196abb88ce663616533',
    },

    adapters: {
        uniswapV2: '0xdeb704836165043c172ae80467249ff87429605f',
        uniswapV3: '0x34e1efca367b1686af9bc3eb9a593c02c2b295f6',
        uniswapV4: '0x907e28e12a36a41a9cf01e1f455f4778408da198',
    },

    factories: {
        uniswapV2: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
        uniswapV3: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    },

    routers: {
        uniswapV2: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
        // SwapRouter02 variant — see `UniswapV3SwapRouter02Adapter`.
        uniswapV3: '0xcaf681a66d020601342297493863e78c959e5cb2',
        uniswapV4: '0x8876789976decbfcbbbe364623c63652db8c0904',
    },

    quoters: {
        uniswapV3: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
        uniswapV4: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    },

    routeBridges: ['0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31'], // VIRTUAL

    tokens: {
        WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
        // Robinhood currently exposes USDG as the stable anchor. USDC/USDT are
        // compatibility aliases for SDK call sites that expect those keys.
        USDC: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
        USDT: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
        USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    },
} as const

export const GURU_PROTOCOL_ADDRESSES: Readonly<
    Record<GuruProtocolChainId, GuruProtocolAddresses>
> = {
    1: MAINNET,
    8453: BASE,
    4663: ROBINHOOD,
}

export const SUPPORTED_CHAIN_IDS: readonly GuruProtocolChainId[] = [
    1, 8453, 4663,
] as const

export const isSupportedChainId = (
    chainId: number
): chainId is GuruProtocolChainId =>
    chainId === 1 || chainId === 8453 || chainId === 4663

export function getGuruProtocolAddresses(
    chainId: number
): GuruProtocolAddresses {
    if (!isSupportedChainId(chainId)) {
        throw new UnsupportedChainError(chainId)
    }
    return GURU_PROTOCOL_ADDRESSES[chainId]
}
