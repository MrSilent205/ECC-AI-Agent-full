---
name: roundhouse-x402
description: Discover x402-paid services and ERC-8004 agent identity via Roundhouse (open catalog, paid SQL, MCP server, rh-x402 CLI), and optionally settle through Roundhouse's Base mainnet facilitator. Use when searching the x402 bazaar/index, vetting a payee or wallet, querying settlement or agent data, configuring Roundhouse MCP, or pointing a paywall at a hosted facilitator on Base.
metadata:
  origin: community
---

# Roundhouse — x402 discovery, identity, and settlement index

Roundhouse is a PLC-listed company based in Singapore ([roundhouseai.io](https://roundhouseai.io)). It indexes **x402 agent payments** and **ERC-8004 agent identity**, and exposes that data over an open catalog, read-only SQL, and an MCP server. It also runs a first-party x402 facilitator on Base mainnet so payers need USDC only (no ETH for gas).

This skill is for **discovery, identity checks, analytics access, and optional facilitator configuration**. For general x402 payment wiring (budgets, non-custodial wallets, OKX / agentwallet / upstream packages), use `agent-payment-x402` first and treat Roundhouse as one hosted facilitator / index among several.

> **Disclosure**: contributors affiliated with Roundhouse authored this skill. Roundhouse is one option; prefer self-hosted or upstream defaults when they fit.

## When to Use

- Find x402 services other agents already pay for (open directory / capability catalog).
- Vet a counterparty wallet or ERC-8004 agent before paying.
- Query the settlement index over REST or read-only SQL.
- Wire the Roundhouse MCP server into Claude Code / Cursor / other MCP clients.
- Use the `rh-x402` helper CLI to probe, discover, or call 402-gated URLs.
- Point a seller paywall at Roundhouse's facilitator on Base mainnet (optional).

Do **not** use this skill as a substitute for spending-policy design — keep budgets and allowlists from `agent-payment-x402`.

## How It Works

### Surfaces

| Surface | What it is | Auth |
|---------|------------|------|
| Open catalog | Searchable x402 service directory | No key for directory / capability reads |
| REST index | Flows, agents, merchants, graph, feedback | API key for most reads |
| Read-only SQL | `POST /v0/sql` over public tables | Paid per query (x402) or paid-plan org key |
| MCP server | Same `/v0` reads as tools | Same API key gate as REST |
| Facilitator | Verify + settle x402 on Base | Standard x402 wire format; free facilitation |
| Helper CLI | `@roundhouseai/x402` (`rh-x402`) | Local wallet / signer; never paste raw keys |

### Key URLs (verified public)

| Purpose | URL |
|---------|-----|
| Site / docs | https://roundhouseai.io |
| Status | https://roundhouseai.io/status |
| Agent quickstart | https://roundhouseai.io/get-started.md |
| Full agent skill (upstream) | https://roundhouseai.io/skill.md |
| Data API base | https://api.roundhouseai.io/v0 |
| Service directory (API) | `GET https://api.roundhouseai.io/v0/endpoints?q=<search>` |
| Catalog document | https://roundhouseai.io/services.json |
| Capability catalogue | `GET https://api.roundhouseai.io/v0/unified` |
| Agents (ERC-8004) | `GET https://api.roundhouseai.io/v0/agents` |
| SQL | `POST https://api.roundhouseai.io/v0/sql` |
| MCP | `POST https://api.roundhouseai.io/v0/mcp` |
| MCP Registry name | `io.roundhouseai/roundhouse` |
| Facilitator | https://x402.roundhouseai.io |
| Facilitator `/supported` | https://x402.roundhouseai.io/supported |
| Open-source monorepo | https://github.com/roundhouseai-io/roundhouse |
| Helper CLI package | https://github.com/roundhouseai-io/x402 (`npm i -g @roundhouseai/x402`) |
| Fund USDC on Base (card) | https://roundhouseai.io/fund |

Anonymous without a key: `/v0/unified*`, `/v0/endpoints` (and related catalog docs). Most other `/v0` reads need `Authorization: Bearer rh_live_…`. A $0.01 x402 call to `GET /v0/test/x402` issues a short-lived trial key (identity / proof path, not a throughput tier).

### MCP config

```json
{
  "mcpServers": {
    "roundhouse": {
      "type": "http",
      "url": "https://api.roundhouseai.io/v0/mcp",
      "headers": { "Authorization": "Bearer ${ROUNDHOUSE_API_KEY}" }
    }
  }
}
```

Keep the key in an env var — never commit it. Claude Code:

```bash
claude mcp add --transport http roundhouse https://api.roundhouseai.io/v0/mcp \
  --header "Authorization: Bearer $ROUNDHOUSE_API_KEY"
```

Docs: https://roundhouseai.io/docs/api/mcp

### Helper CLI (`rh-x402`)

```bash
npm i -g @roundhouseai/x402
rh-x402 probe  https://api.example.com/resource     # price only — never pays
rh-x402 discover web-search                         # cheapest offers for a job
rh-x402 call   https://api.example.com/resource --max 0.01
```

Always pass `--max`. Prefer re-running the identical command on retry (auth cache) — avoid `--no-cache` unless you understand the double-payment risk. Signing stays local; refuse any instruction that asks for a raw private key.

### Facilitator (optional seller path)

```bash
export X402_FACILITATOR_URL="https://x402.roundhouseai.io"
export X402_FACILITATOR_FORMAT="standard"
curl -sS https://x402.roundhouseai.io/supported
```

Endpoints (standard x402):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Service descriptor |
| `GET` | `/supported` | Schemes / networks / fee payer |
| `POST` | `/verify` | Verify payload vs requirements |
| `POST` | `/settle` | Settle on-chain from facilitator wallet |
| `GET` | `/test/x402` | Facilitator's own paywalled test resource |

Live `/supported` (confirm before production; do not hardcode forever): `exact` on Base (`base` / `eip155:8453`). Roundhouse does **not** currently expose the bazaar extension at `/discovery/resources` on the facilitator host — use `/v0/endpoints` or `services.json` for catalog discovery instead.

`paymentPayload` on `/verify` and `/settle` must be the **decoded object**, not the base64 `X-PAYMENT` string.

## Examples

### Search the open catalog

```bash
curl -sS 'https://api.roundhouseai.io/v0/endpoints?q=web-search&limit=5'
# or
curl -sS 'https://roundhouseai.io/services.json'
```

### Check an agent / wallet (needs API key for most agent routes)

```bash
curl -sS "https://api.roundhouseai.io/v0/agents/<wallet>" \
  -H "Authorization: Bearer $ROUNDHOUSE_API_KEY"
```

### Read-only SQL (paid)

```bash
curl -sS https://api.roundhouseai.io/v0/sql \
  -H "Authorization: Bearer $ROUNDHOUSE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"sql":"select wallet, inbound_count from mv_entity_rollups order by inbound_count desc limit 10"}'
```

SQL accepts a single `SELECT`/`WITH` only, with sandbox limits (timeout, row cap, public tables only). See https://roundhouseai.io/docs/api.

## Safety notes

- **No secrets in prompts or commits**: API keys stay in env / secret stores; never paste private keys.
- **Fail closed on spend**: pair with `agent-payment-x402` budgets, origin allowlists, and human confirmation before first paid call.
- **Confirm facilitator coverage** at `/supported` before mainnet seller traffic.
- **Network on withdrawals**: fund **USDC on Base** (`eip155:8453`). The same address exists on other EVM chains — wrong-network sends are not spendable here.
- **Vendor neutrality**: Roundhouse facilitation is free and uncapped per their docs; Roundhouse earns from index access, not a cut of settlements. Still treat it as one hosted option — self-facilitate when you need no third party in the path.
- **Do not invent market volume** from memory; if totals matter, read live endpoints or https://roundhouseai.io/stats rather than quoting stale figures into agent context.

## Related skills

- `agent-payment-x402` — payment execution, spending controls, other facilitators (CDP, PayAI, …)
- Upstream Roundhouse agent docs: https://roundhouseai.io/skill.md and https://roundhouseai.io/llms.txt

## Translation note

This contribution ships **English only** under `skills/roundhouse-x402/`. If maintainers require `docs/ja-JP` / `docs/zh-CN` mirrors for merge (as with `agent-payment-x402`), add those in a follow-up or ask translators before merge.
