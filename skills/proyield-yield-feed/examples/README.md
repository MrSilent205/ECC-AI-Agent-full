# `proyield-yield-feed` examples

Every script here runs against the live, public `pyd.fi` API. Nothing is mocked.
The free examples need no account, no key, and no money.

| File | Needs | Costs | What it does |
| --- | --- | --- | --- |
| `curl-free.sh` | `curl` | free | Walks the whole free read tier: discovery, venue rates, a position read, the `400` error contract, unsigned deposit calldata, the machine-payment tally, and a live `402` challenge |
| `read-free.mjs` | Node 18+ | free | The free tier from JavaScript: timeout, `429`/`Retry-After`, `errors[]` handling, and provenance (`as_of` vs `generated_at`) done correctly |
| `pay-x402.mjs` | Node 18+, `npm i viem` | $0.005 USDC | A complete x402 pay flow (EVM networks only): free index → `402` challenge → budget/allowlist check → fresh EIP-3009 signature → paid retry → receipt → receipt-primary settlement check with an all-payer tally cross-check |

## Running them

```bash
bash curl-free.sh                       # free
node read-free.mjs                      # free
PROYIELD_PAYER_KEY=0x… node pay-x402.mjs   # spends $0.005 USDC on Base
```

`pay-x402.mjs` can target any advertised **EVM** network:

```bash
PROYIELD_PAYER_KEY=0x… PROYIELD_NETWORK=eip155:137 node pay-x402.mjs
```

> **The shipped example is EVM-only.** `/api/agents` advertises Solana
> (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) as a settlement network, but paying
> on it requires an SPL `TransferChecked` signer that this example does not
> implement. Selecting Solana fails up front, before anything is signed — it is
> not a working path here.

## Notes on the paid example

- The key is read from `PROYIELD_PAYER_KEY` and is never printed, logged, or put
  in a header. The API only ever sees a signature and an authorization.
- The payable origin is pinned to `https://pyd.fi` and redirects are refused.
- The price is checked against a local per-call cap *before* anything is signed.
- **Pin the recipient caller-side when the server is not trusted.** `payTo`,
  `asset`, `amount` and `network` all come from the resource server, so set
  `PROYIELD_ALLOWED_PAY_TO` (comma-separated `payTo` or `payTo@asset`) and the example
  hard-fails before signing if the challenge asks for anything else. Unset, it
  proceeds and warns — it is a worked example, not a wallet.
- The example signs EVM (`EIP-3009`) only; Solana is rejected before signing.
- A fresh random nonce is used every call: a replay returns `409 payment_replay`,
  and a same-nonce retry is not a fresh payment.
- Settlement is taken from the response's own `PAYMENT-RESPONSE` receipt
  (`success`, `network`, `transaction`); a `200` without a readable receipt is
  treated as **unconfirmed**. The aggregate `/api/x402/stats` tally is read only
  as a cross-check — it counts every payer, so it can move by more than one.

The payer needs USDC on the chosen network but **no native gas token** — the
facilitator sponsors settlement gas.

## Captured output

Verified live against `pyd.fi`:

```
Pro Yield paid rail — $0.005/call
networks advertised: Base, Arbitrum One, Polygon, Avalanche, X Layer, World Chain, Sei, Solana
challenge x402Version=2 · 5000 atomic units
payTo 0x8A1b107e1DDabC868E40b8718F09537B0A50C9aB · asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 · cap ok
HTTP 200 + PAYMENT-RESPONSE
settled on eip155:8453: 0xd7447539a143c449410e0f41d013f33169dab0ecff38807d3de4015df0371523
tally cross-check 15 -> 16 (+1, 0.005 USDC)
as_of 2026-10-14T03:49:19.346Z · kind all · spent $0.005
```

Rates and figures move. Re-run rather than trusting a pasted number — and read
`errors[]` before trusting any single figure.
