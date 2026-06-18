# @guru-fund/sdk

Quote + transaction builders for Guru Protocol managed funds.

The SDK is submission-agnostic: every quote returns a `txData: TransactionRequest`
plus a `decodeLogs(logs)` closure. You sign and broadcast yourself. Simulation
is a caller-supplied callback so the SDK never reaches Alchemy / Tenderly /
your provider of choice directly.

## Install

```sh
npm install @guru-fund/sdk ethers
```

Peer-quality runtime deps: `ethers` (>=6.15) and `zod`. Zero internal /
proprietary deps — the SDK is meant to be standalone-publishable.

## Constructor

```ts
import { GuruProtocol } from '@guru-fund/sdk'

const protocol = new GuruProtocol({
    rpcUrl: 'https://mainnet.infura.io/v3/<key>',
    chainId: 1, // mainnet (1) and base (8453) are supported
})
```

`new GuruProtocol({ rpcUrl, chainId })` is the only required surface. The constructor:

-   Builds an internal `JsonRpcProvider(rpcUrl)`. Do not pass a provider in.
-   Resolves the Guru Protocol contract addresses from the SDK's vendored registry. Do
    not pass contracts in.
-   Throws `UnsupportedChainError` for any chain outside `{ 1, 8453 }`.

Optional override slots (`GuruProtocolOptions`): `simulator`, `getSwapFeePercentage`,
`getPriceUsd1e18`, `veloraEndpoint`, `getPath`. Each has a sensible default —
see the no-sim pattern and the Alchemy pairing example below.

## Quote methods

Every quote method returns bigints natively. Stringify at your wire boundary
if you serialize to JSON.

| Method                     | Returns                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `protocol.quoteDeposit`    | `{ sharesOutMin, extCalls, fees, referrerFeeBps, …, txData, decodeLogs }`      |
| `protocol.quoteWithdrawal` | `{ proceeds, extCalls, routing, referrerFeeBps, …, txData, decodeLogs }`       |
| `protocol.quoteTrade`      | `Route + txData` for one-off manager trade execution                           |
| `protocol.quoteHarvest`    | `{ extCalls, harvestableFraction, managementFee, txData, decodeLogs }`         |
| `protocol.quoteRebalance`  | `{ extCalls, trades, cumulativeSlippageBps, txData, decodeLogs, emptyReason }` |

```ts
const quote = await protocol.quoteDeposit({
    ledger: '0xe93f393b987247530a94cef205070868924797e7',
    account: '0xUserAddress',
    coin: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    amount: 1_000_000n, // 1 USDC (6 decimals)
    referrerFeeBps: 0n, // see "Referrer fee policy" below
})

// 1. Submit `quote.txData` from `account`. Approvals are out-of-band.
// 2. After execution (or sim), pipe receipt logs through quote.decodeLogs:
const decoded = quote.decodeLogs(receipt.logs)
//   { expectedShares: 1234n } | null
```

### Referrer fee policy

`referrerFeeBps` is a required input on deposit / withdrawal. The SDK
range-validates `0 <= referrerFeeBps <= MAX_BPS (=10_000n)` but does NOT
derive it. Policies that depend on server-side data (governance-token
holdings, fund composition, holdings checks) belong outside the SDK — pass
the resolved bps in.

`slippageSettings` on deposit / withdrawal / harvest / rebalance are optional
per-token e3 slippage overrides (`"500"` = 0.5%). They become especially
important in no-sim mode, where callers may want explicit bounds instead of
the router defaults.

## Transaction builders

Static, synchronous calldata encoders. Use directly when you already know the
deposit / withdraw / harvest shape and want a `TransactionRequest` without
going through the quote.

```ts
const tx = GuruProtocol.buildDepositTx({
    controller, ledger, coin, amount, sharesOutMin, extCalls,
    referrerFeeBps, from,
})
GuruProtocol.buildWithdrawTx({ controller, ledger, coin, amountIn, extCalls, …, from })
GuruProtocol.buildHarvestTx({ controller, ledger, coin, isManagementFeeEligible, extCalls, …, from })
```

The quote methods call these builders internally — single source of truth for
calldata shape.

Approvals are NOT bundled into deposit txData — handle them yourself before
submitting the quote's `txData`.

## No-sim pattern

The default `simulator` callback returns `{ success: false }`, which causes
the Velora primary router to fall through to the caller-supplied slippage
without doing on-chain "highest-passing-amount" search. This is the
zero-config path — quotes still work, but they are degraded for real execution
quality because the SDK cannot validate route executability against current
liquidity conditions.

```ts
const protocol = new GuruProtocol({ rpcUrl, chainId })
// simulator defaults to noop — callers get caller-supplied-slippage quotes
```

## Alchemy sim pairing example

Inject a custom simulator to recover the search behavior. Below uses Alchemy
Bundle Simulation; substitute Tenderly / your own provider with the same
callback shape.

```ts
import { GuruProtocol, type SwapSimulator } from '@guru-fund/sdk'
import { Alchemy, Network } from 'alchemy-sdk'

const alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY!,
    network: Network.ETH_MAINNET,
})

const simulator: SwapSimulator = async ({
    chainId,
    from,
    to,
    callData,
    blockNumber,
    account,
    amountIn,
    tokenIn,
}) => {
    try {
        const bundle = await alchemy.transact.simulateExecutionBundle(
            [
                // optional ERC20 prelude funding the controller
                {
                    from: account,
                    to: tokenIn,
                    value: '0x0',
                    data: encodeApprove(to, amountIn),
                },
                { from, to, value: '0x0', data: callData },
            ],
            { blockNumber: `0x${blockNumber.toString(16)}` }
        )
        const target = bundle[bundle.length - 1]
        return {
            success: !target.error && !target.revertReason,
            revertMessage: target.revertReason ?? target.error?.message,
        }
    } catch (err) {
        return { success: false, revertMessage: String(err) }
    }
}

const protocol = new GuruProtocol({ rpcUrl, chainId, simulator })
```

`SimulateSwapParams` and `SimulateSwapResult` are exported types — the SDK
will only ever call your callback with the documented shape.

## Custom routing

By default the SDK fetches swap paths from Velora's DEX aggregator API. You might
override this if Velora changes endpoints, you have an API key for a private
instance, or you want to plug in a different routing backend entirely:

```ts
// Just change the endpoint
const protocolWithCustomEndpoint = new GuruProtocol({
    rpcUrl,
    chainId,
    veloraEndpoint: 'https://custom-velora.example/swap',
})

// Full custom path logic
import type { PathFetcher } from '@guru-fund/sdk'

const getPath: PathFetcher = async ({ chainId, dex, tokenIn, tokenOut }) => {
    // your routing backend — return CachedPath or false
}

const protocolWithCustomPath = new GuruProtocol({ rpcUrl, chainId, getPath })
```

`PathFetcher`, `GetPathParams`, and `CachedPath` are exported types.

## Decoding receipts

`decodeLogs(logs)` is a closure baked into each quote result. It reads the
contract event ABIs the SDK already has, so you don't have to assemble them
yourself. Returns `null` on miss (event not present) — pair it with a
sensible fallback in your code.

```ts
const tx = await wallet.sendTransaction(quote.txData)
const receipt = await tx.wait()
const decoded = quote.decodeLogs(receipt!.logs) ?? {
    expectedShares: quote.sharesOutMin, // sensible fallback
}
```

## Errors

-   `UnsupportedChainError` — thrown by the constructor on `chainId` outside
    `{ 1, 8453 }`.
-   `z.ZodError` — thrown by quote methods on malformed inputs (zod schema at
    the SDK boundary parses every quote method's input).
-   `SdkError` — internal errors (e.g., `EVENT_NOT_FOUND` from the receipt
    parser, `NETWORK_NOT_SUPPORTED` from the pool helper).
-   Plain `Error` — semantic invariants like "coin is not a supported
    stablecoin", "toll not applicable", "target weights do not sum to UNIT".

## License

MIT.
