---
name: proyield-yield-feed
description: Read live stablecoin lending yields, vault state and daily share-price history from Pro Yield's public API at pyd.fi, including the free read tier (no account or key) and the optional $0.005-per-call x402 machine rail. Use when an agent needs current, sourced DeFi stablecoin venue rates with provenance, a share-price series for a backtest, a non-custodial USDC vault's live caps, or a worked example of paying for an API call with x402 in USDC.
metadata:
  origin: community
---

# Pro Yield Yield Feed (pyd.fi)

Pro Yield publishes a read-only yield API at `pyd.fi`: curated stablecoin lending
venue rates with safety tiers, a non-custodial USDC vault's live on-chain state,
and the vault's daily share-price history. Every response is sourced and dated.
This skill is a client-side guide to reading it.

The project's website is **proyield.fi**; the API machine host is **pyd.fi**.
Every example below talks to `pyd.fi`, because that is where the JSON API lives.

Two surfaces, one data model:

- a **free read tier** (`/api/yield/*`) — no account, no key, open CORS, rate-limited;
- an optional **paid machine rail** (`/api/agents/*`) — USDC per call over x402,
  no signup, for agents that want a single billable call with a settlement receipt.

Everything this skill touches is public, read-only data. Pro Yield never signs,
never custodies, and never holds keys for you; the API is data plus unsigned
calldata, nothing more.

> Not financial advice. Rates are historical, sourced reads — not forecasts and
> not promises. DeFi carries real risk, including contract exploits and depegs.
> This skill is read-only: it describes fetching data, not an investment.

## When to Activate

Use this skill when any of the following is true:

- The task needs **current stablecoin lending rates** on blue-chip venues, with a
  source and timestamp attached to each figure rather than an unsourced number.
- The task needs a **risk-adjusted USDC rate anchor** — a published blend target
  plus the curated venue list behind it, not a single cherry-picked pool.
- The task needs **share-price history** for a stablecoin vault (daily points, no
  interpolation, gaps reported as null) to chart, backtest, or sanity-check.
- The task needs to **check a vault's live capacity** — total assets, share price,
  and the code-enforced TVL / per-wallet caps — before telling a user to deposit.
- The task needs **unsigned deposit or withdraw calldata** for a non-custodial
  USDC vault, to be signed by the user's own wallet.
- The task is building or testing an **x402 payer**: these endpoints are a live
  $0.005 resource that advertises eight settlement networks and returns a real
  settlement receipt.
- You are working in the **Pro Yield** project and need the exact live response
  shape instead of a guess.

Do **not** activate this skill to place trades, move user funds, or produce
return projections. It reads a data feed and builds unsigned transactions.

## Core Concepts

### The free read tier

Three endpoints under `/api/yield/`, no key required, open CORS, per-IP rate
limits (a `429` carries `Retry-After`):

| Endpoint | Method | What it returns |
| --- | --- | --- |
| `/api/yield/strategies` | GET | Vault identity + live caps, deployed strategy split, curated venue rates with safety tiers, blend anchor, provenance |
| `/api/yield/positions?address=0x…` | GET | Live position read for any wallet: shares, position value, wallet USDC |
| `/api/yield/build-tx` | POST | **Unsigned** deposit/withdraw calldata for the caller's wallet to sign |

`https://pyd.fi/llms.txt` is the machine-discovery file for the whole surface, and
`https://pyd.fi/openapi.json` is an OpenAPI 3.1 description.

### The paid machine rail

Four resources under `/api/agents/`, **$0.005 per call** in USDC: `/yields`
(venue rates + blend anchor + provenance), `/vault` (share price, total assets,
live caps; `?address=` adds a position), `/all` (yields and vault in one call —
cheaper than two), and `/series` (daily share-price series from the signed
attestation feed). `/api/agents` itself is a **free index** listing resources,
prices and accepted networks — fetch it first.

### Eight settlement networks

The `accepts[]` array in a 402 challenge advertises eight CAIP-2 networks:
`eip155:8453` Base (primary) · `eip155:42161` Arbitrum One · `eip155:137` Polygon ·
`eip155:43114` Avalanche · `eip155:196` X Layer · `eip155:480` World Chain ·
`eip155:1329` Sei · `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` Solana.

The payer picks one entry from `accepts[]`. The facilitator sponsors settlement
gas, so the payer needs USDC but no native gas token.

### How payment is verified (buyer mechanics live elsewhere)

This skill is the **resource side** — what the endpoints are and what they
return. The buyer-side protocol mechanics (budgets, spending policy, origin
pinning, scheme registration) are documented in the `agent-payment-x402` skill;
use it rather than re-deriving them here. In short:

- **EVM networks** settle with **EIP-3009** `TransferWithAuthorization` — an
  off-chain signature over `(from, to, value, validAfter, validBefore, nonce)`
  submitted by the facilitator. The EIP-712 domain needs the USDC `name` and
  `version` ("USD Coin" / "2"), which arrive in the challenge entry's `extra`.
- **Solana** settles as an SPL `TransferChecked` token transfer.
- A settled response carries a **`PAYMENT-RESPONSE`** header whose base64 JSON
  includes the settlement `transaction` hash and the `network`.
- **Reusing a settled authorization returns `409 payment_replay`** — the nonce is
  single-use, so always sign a fresh one.
- Solana mainnet is not available through the `x402.org` facilitator, which is
  testnet-only. Use a hosted mainnet facilitator or self-facilitate.

### Provenance is the point

Every response carries `as_of` (when the underlying data was measured) and
`generated_at` (when the response was built), which are **not** the same field.
`venue_rates.source` names upstream (for example `yields.llama.fi/pools
(DefiLlama)`). Per-network failures degrade into an `errors[]` array instead of
failing the whole response, so read `errors[]` before trusting a figure. A `null`
means "no reading", never zero.

### What the numbers are, and are not

- Rates are **historical, sourced reads** of live venue pools.
- The blend figure is explicitly a **policy anchor from measured history**,
  published with `"guarantee": false`. Do not restate it as a rate the vault pays.
- The vault is a **guarded beta with code-enforced caps; no external audit is
  complete.** The caps are readable from the API (`caps.tvl_usdc`,
  `caps.per_user_usdc`, `caps.deposits_paused`) and rise with evidence.
- `/api/yield/build-tx` returns **unsigned** calldata. Pro Yield never signs,
  never custodies, never holds keys.
- `/api/x402/stats` reports aggregate settled-call count and total USDC received,
  deliberately without payer addresses or per-call data — an independent,
  server-side confirmation that a settlement landed.

## Code Examples

Outputs below were captured live from `pyd.fi` and reproduced verbatim (trimmed,
with `…` marking elision). Live figures move — re-run rather than trusting a
pasted number.

### 1. Free: curated venue rates and vault state

```bash
curl -s https://pyd.fi/api/yield/strategies
```

```json
{
  "api": "proyield-yield-api",
  "kind": "strategy_catalog",
  "as_of": "2026-10-13T16:10:10.745Z",
  "generated_at": "2026-10-14T03:37:32.190Z",
  "network": { "name": "HyperEVM Mainnet", "chain_id": 999 },
  "vault": {
    "address": "0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1",
    "share_price_usdc": 1.0283825969412874,
    "total_assets_usdc": 126.282995,
    "idle_usdc": 5.714922,
    "caps": { "tvl_usdc": 10000, "per_user_usdc": 1000, "deposits_paused": false }
  },
  "strategies": [
    { "kind": "lending", "name": "Morpho Blue", "address": "0xBF4C…2D53", "assets_usdc": 50.53596, "apy_pct": 4.22 },
    { "kind": "funding", "name": "Funding sleeve", "address": "0xeD40…9Bf4", "assets_usdc": 30.586128, "apy_pct": 10.95 },
    { "kind": "fixed", "name": "Fixed-rate sleeve (PT, ETH lane)", "address": "0xA96D…4b25", "assets_usdc": 19.036804, "apy_pct": 12.16 },
    { "kind": "lending", "name": "HL Earn (idle-cash)", "address": "0xA2e5…4dF5", "assets_usdc": 17.956858, "apy_pct": null }
  ],
  "blend": {
    "target_pct": 6.51,
    "guarantee": false,
    "note": "policy anchor from measured history — not a promised rate"
  },
  "venue_rates": {
    "source": "yields.llama.fi/pools (DefiLlama)",
    "generated_utc": "2026-10-13T13:01:50Z",
    "core_rates": [
      { "apy": 6.67377, "chain": "Monad", "full": "morpho-blue HYPERUSDCA", "tag": "core", "tvl": 52576627 },
      { "apy": 5.87, "chain": "Ethereum", "full": "sky-lending STUSDS", "tag": "core", "tvl": 185315253 }
    ]
  },
  "errors": []
}
```

One sleeve shows `"apy_pct": null` — no live rate read at capture time. Report it
as unmeasured; never substitute a number.

### 2. Free: a wallet's vault position (and the 400 contract)

```bash
curl -s "https://pyd.fi/api/yield/positions?address=0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1"
```

```json
{
  "api": "proyield-yield-api",
  "kind": "position",
  "as_of": "2026-10-14T03:37:35.507Z",
  "network": { "name": "HyperEVM Mainnet", "chain_id": 999 },
  "address": "0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1",
  "vault": {
    "shares": 0, "value_usdc": 0, "share_price_usdc": 1.0284,
    "percent_of_vault": 0, "total_assets_usdc": 126.285262, "total_shares": 122.797678
  },
  "wallet": { "usdc_hyperevm": 5.717189 },
  "notes": [
    "earnings are not computed in v0 — subtract your deposit history from value_usdc",
    "reads are live eth_calls at request time; value uses the vault's offset share math"
  ],
  "errors": []
}
```

Missing or malformed `address` is a **`400` with a stable machine-readable code**,
not an HTML error page:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://pyd.fi/api/yield/positions"
# 400
```

```json
{
  "error": "invalid_address",
  "message": "Provide ?address= as a 0x-prefixed 20-byte hex address, e.g. /api/yield/positions?address=0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1"
}
```

Handle the `error` code, not the prose. Validate the address shape before spending
a request: `0x` plus 40 hex characters.

### 3. Free: unsigned deposit calldata

```bash
curl -s -X POST https://pyd.fi/api/yield/build-tx \
  -H 'Content-Type: application/json' \
  -d '{"address":"0x…","action":"deposit","amount_usdc":1}'
```

```json
{
  "api": "proyield-yield-api",
  "kind": "build_tx",
  "action": "deposit",
  "amount_usdc": 1,
  "amount_raw": "1000000",
  "txs": [
    { "step": "approve", "to": "0xb88339CB7199b77E23DB6E890353E22632Ba630f", "data": "0x095ea7b3…ffff", "value": "0x0", "chain_id": 999,
      "description": "One-time MAX USDC approval for the vault (same as the ProYield app) — needed once, then deposits are a single signature." },
    { "step": "deposit", "to": "0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1", "data": "0xb6b55f25…0f4240", "value": "0x0", "chain_id": 999 }
  ],
  "quote": {
    "share_price_usdc": 1.0284, "shares_estimate": 0.972383, "wallet_usdc": 5.717189,
    "caps": { "tvl_usdc": 10000, "per_user_usdc": 1000, "deposits_paused": false }
  },
  "notes": [
    "Unsigned calldata only — your wallet signs and broadcasts. ProYield never custodies, never signs.",
    "Numbers are live chain reads at build time — sign promptly; a stale amount can fail the caps."
  ],
  "errors": []
}
```

The response is a **list of steps** because a first deposit needs an ERC-20
approval before the deposit itself; submit them in order. Validation failures are
`400`/`422` with a machine-readable code, for example
`{"error":"insufficient_balance","message":"Wallet holds $5.72 USDC on HyperEVM.","balance_usdc":5.717189}`
or `{"error":"invalid_action","message":"action must be \"deposit\" or \"withdraw\"."}`.
Sign the returned calldata with the user's own wallet; never send a key to this API.

### 4. Free: the machine-payment tally

```bash
curl -s https://pyd.fi/api/x402/stats
```

```json
{
  "api": "proyield-x402", "version": 2, "kind": "x402_stats",
  "as_of": "2026-10-14T03:46:00.776Z",
  "calls_settled": 11,
  "total_received_usdc": 0.055,
  "note": "Aggregate only — no payer addresses, resources or per-call data.",
  "errors": []
}
```

`calls_settled` is an aggregate across *every* payer, so read it as a **cross-check
only**: a concurrent payer moves it by more than one, and a failed purchase can
land inside a `+1` window. The evidence for *your* call is its own
`PAYMENT-RESPONSE` receipt (§7); a `200` with no readable receipt is unconfirmed.

### 5. Free tier from JavaScript/TypeScript

No key, no header, no signup — plain `fetch`, with `errors[]` honoured and a
timeout so a rate-limited read cannot hang an agent loop.

```js
async function readProYield(path, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://pyd.fi${path}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 429) throw new Error(`rate limited; retry after ${res.headers.get("retry-after") ?? 5}s`);
    const body = await res.json();
    // Partial failures arrive as data, not as a non-200: surface them, don't swallow them.
    if (Array.isArray(body.errors) && body.errors.length > 0) console.warn("partial data:", body.errors);
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const catalog = await readProYield("/api/yield/strategies");
const { share_price_usdc, caps } = catalog.vault;
console.log(`share price ${share_price_usdc} · caps ${caps.tvl_usdc} TVL / ${caps.per_user_usdc} per wallet · paused: ${caps.deposits_paused}`);
console.log(`blend anchor ${catalog.blend.target_pct}% (guaranteed: ${catalog.blend.guarantee})`);
```

### 6. The paid rail: what a 402 challenge looks like

Fetching a paid resource with **no** payment header returns `402` and a
machine-negotiable challenge in two artifacts: the **`PAYMENT-REQUIRED` response
header** (base64 JSON, `x402Version: 2`) and a **JSON body** (`x402Version: 1`,
legacy mirror).

```bash
curl -s -i https://pyd.fi/api/agents/yields | head -12
```

```http
HTTP/2 402
content-type: application/json; charset=utf-8
payment-required: eyJ4ND…19fQ==
access-control-expose-headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE
```

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "maxAmountRequired": "5000",
      "resource": "https://pyd.fi/api/agents/yields",
      "mimeType": "application/json",
      "payTo": "0x8A1b107e1DDabC868E40b8718F09537B0A50C9aB",
      "maxTimeoutSeconds": 300,
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }
  ]
}
```

`maxAmountRequired` is in the asset's atomic units (`"5000"` = $0.005 USDC).
Select the entry whose `network` your payer supports — do not default to the first
entry without checking. The v2 header adds a `resource` object with `serviceName`,
`tags` and `iconUrl`, and each accept entry carries `amount` plus
`extra: {"name":"USD Coin","version":"2"}` — what an EIP-3009 signer needs for its
EIP-712 domain. The body-vs-header naming difference (`maxAmountRequired` vs
`amount`) trips up naive clients.

### 7. The paid rail: a successful settlement

Retrying the same URL with a `PAYMENT-SIGNATURE` header built from the challenge
returns `200` plus a receipt. Decoding the `PAYMENT-RESPONSE` header gives:

```json
{
  "success": true,
  "payer": "0xaDD8f2678De34FD06C158DD80C5253A504A5EA1D",
  "transaction": "0x17bdb00d2cefaf3ae0fb6bc310649f966191dbde91f99bf0eaff2d7e328e455c",
  "network": "eip155:8453"
}
```

Two networks verified live end-to-end (0.005000 USDC → the `payTo` address, receipts confirmed on-chain):

| Network | Settled | Receipt |
| --- | --- | --- |
| Base (`eip155:8453`) | 0.005000 USDC | tx `0x17bdb00d…e455c`, block 52580102, status success |
| Polygon (`eip155:137`) | 0.005000 USDC | tx `0x39b05433…5404`, block 95496213, status success |

Replaying an already-settled authorization is rejected rather than
double-charging — a byte-identical second request returns:

```json
{
  "error": "payment_replay",
  "message": "This payment authorization was already settled. Sign a new authorization."
}
```

```http
HTTP/2 409
```

### 8. Pay-flow outline (bring your own signer)

Do not paste keys into arguments, logs, or a chat transcript. The full buyer
implementation — spending policy, origin pinning, scheme registration — is in the
`agent-payment-x402` skill; this is only the loop's shape against these endpoints:

1. `GET https://pyd.fi/api/agents` — free index; read prices and networks.
2. `GET <resource>` with no payment header → `402`; decode `PAYMENT-REQUIRED` (or
   read the body's `accepts[]`) and pick one entry by `network`.
3. Check it against your own budget and **caller-held pinning**: origin is exactly
   `https://pyd.fi`, `maxAmountRequired` is within your per-call cap, and `payTo`
   plus `asset` match values *you* hold — the challenge is server-controlled input,
   so a compromised endpoint can substitute either and still look consistent.
4. Sign a **fresh** EIP-3009 `TransferWithAuthorization` for EVM (or an SPL
   `TransferChecked` for Solana; `examples/pay-x402.mjs` implements EVM only) with
   a new random nonce. The key stays in your signer — never in a header, a query
   string, or a log line.
5. Retry the **same URL** with `PAYMENT-SIGNATURE` and the envelope. Expect `200`
   plus `PAYMENT-RESPONSE`.
6. Confirm from that response's own `PAYMENT-RESPONSE` receipt (`success`,
   `network`, `transaction`); use `/api/x402/stats` only as a cross-check. A
   missing receipt is unsettled — and never blind-retry a signed payload: a replay
   returns `409` and a same-nonce retry is not a fresh payment.

## Anti-Patterns

**Do not restate the blend figure as a promised yield.** The payload ships
`"guarantee": false` and a note that it is a policy anchor from measured history.
Copying `6.51` into a projection as "expected return" turns an honest read into a
promise the product explicitly does not make.

**Do not treat `null` as zero.** A sleeve with `"apy_pct": null` or a series day
with `"share_price_usdc": null` means *no reading*, not *no yield*. Series points
are one per attestation with no interpolation — gaps are information.

**Do not ignore `errors[]`.** Partial failures return HTTP `200` with a populated
`errors[]`. A client that reads only the fields it wants will silently present
stale or missing data as complete.

**Do not confuse `as_of` with `generated_at`.** A response generated seconds ago
can carry venue rates measured hours earlier. Quote `as_of` when you quote a rate.

**Do not put a private key in a request.** No key belongs in a URL, a header name,
an argument list, a `console.log`, or a summary you send back to a user. Signing
happens in a signer; the API only ever sees a signature and an authorization.

**Do not blind-retry a paid call.** `409 payment_replay` means the authorization was
already used — the same bytes can never succeed. A timeout after signing is
ambiguous: check the receipt before assuming a loss, and reserve the worst case in
your budget until settlement is confirmed.

**Do not hardcode one network or one facilitator.** `accepts[]` is the source of
truth for what is payable now; `x402.org` is testnet-only, so mainnet Solana and
other mainnet routes need a mainnet facilitator.

**Do not send `build-tx` an amount you have not checked against the caps.** The
builder returns live reads (`tvl_usdc`, `per_user_usdc`, `deposits_paused`) with
its quote; a stale quote can fail the caps on broadcast.

**Do not treat this feed as advice.** It is data and unsigned calldata. Do not use
it to tell a user what return they will get.

## Best Practices

- **Fetch `/api/agents` before paying.** It is free and it is the authoritative
  list of resources, prices and accepted networks for the paid rail.
- **Prefer the free tier unless you specifically need a billable call.** The paid
  rail exists for agents that want one request with a settlement receipt; the same
  underlying data is reachable free and rate-limited.
- **Carry provenance through to the user.** When you surface a rate, carry the
  source and `as_of` with it, and say plainly that it is a historical read.
- **Read caps before recommending action.** Report `caps.deposits_paused`,
  `caps.tvl_usdc` and `caps.per_user_usdc` as live, code-enforced values.
- **Describe the vault accurately.** Guarded beta with code-enforced caps; no
  external audit is complete. Do not upgrade this into a stronger claim.
- **Handle the error contract by code, not prose.** `invalid_address`,
  `invalid_action`, `insufficient_balance`, `nothing_to_withdraw` and
  `payment_replay` are stable; the accompanying `message` is for humans.
- **Respect `429`.** Honour `Retry-After`, back off, and cache reads whose `as_of`
  you have already seen.
- **Keep the payment boundary explicit.** Only the `payTo` address in the live
  challenge is payable; only `pyd.fi` resources are in scope. Reject redirects,
  use absolute URLs, and set a timeout so a paid call cannot hang while a
  reservation is held.
- **Pin `payTo` (and the `asset`) caller-side when the resource server is not
  trusted.** The challenge is server-controlled input; compare `payTo`/`asset`
  against addresses you hold before signing (`PROYIELD_ALLOWED_PAY_TO` in the example).

## Related Skills

- `agent-payment-x402` — the buyer-side x402 implementation this skill pairs with:
  spending policy, per-task budgets, origin pinning, and scheme registration for
  EVM and Solana. Read it for payer mechanics; this skill supplies the live
  resource and the worked responses.
- `defi-yield-research` — method for comparing live DeFi yields across venues,
  including how to read sourced rates without overstating them. *(Pro Yield stack.)*
- `live-data-verification` — the provenance discipline this feed assumes: every
  number traced to a source and a timestamp before it is quoted. *(Pro Yield stack.)*
- `onchain-treasury-operations` — safe handling patterns for agent-adjacent
  wallets and signers, relevant when wiring a payer for the paid rail.
  *(Pro Yield stack.)*
