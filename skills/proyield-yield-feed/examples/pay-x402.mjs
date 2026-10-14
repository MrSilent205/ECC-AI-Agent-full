// Pro Yield paid machine rail — a complete x402 pay flow against pyd.fi.
//
// Run:  PROYIELD_PAYER_KEY=0x… node pay-x402.mjs [resource-url]
// Needs: npm i viem          (Node 18+)
//
// Discipline this example is built around:
//   * the key is read from the environment and never printed, logged, or put in
//     a header — the API only ever sees a signature and an authorization
//   * the payable origin is pinned to https://pyd.fi and redirects are rejected
//   * the price is checked against a local per-call cap before anything is signed
//   * a fresh random nonce every call, because a replay returns 409 and a
//     same-nonce retry is not a fresh payment
//   * settlement is confirmed from THIS call's PAYMENT-RESPONSE receipt
//     (`success`, `network`, `transaction`); /api/x402/stats is an all-payer
//     aggregate and is used only as a cross-check, never as proof
//   * the payTo/asset the server asks to be paid can be pinned caller-side
//     (PROYIELD_ALLOWED_PAY_TO) so a hostile resource server cannot substitute them
//
// Buyer-side protocol mechanics (spending policy, budgets, scheme registration)
// live in the `agent-payment-x402` skill. This file is the resource-side loop.

import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const ORIGIN = "https://pyd.fi";
const RESOURCE = process.argv[2] ?? `${ORIGIN}/api/agents/yields`;
const TARGET_NETWORK = process.env.PROYIELD_NETWORK ?? "eip155:8453"; // Base
const PER_CALL_CAP_ATOMIC = 5_000n; // $0.005 — refuse to sign above this
const PRICE_USDC = 0.005;

const CHAIN_IDS = {
  "eip155:8453": 8453,
  "eip155:42161": 42161,
  "eip155:137": 137,
  "eip155:43114": 43114,
  "eip155:196": 196,
  "eip155:480": 480,
  "eip155:1329": 1329,
};

const b64d = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));
const b64e = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const tryB64d = (s) => {
  try {
    return b64d(s);
  } catch {
    return null;
  }
};

// ── guard rails ──────────────────────────────────────────────────────────────

function assertPinned(url, label) {
  const u = new URL(url);
  if (u.origin !== ORIGIN) throw new Error(`${label}: refusing non-pinned origin ${u.origin}`);
  return u;
}

// Every payer request is bounded with AbortController + signal, mirroring the
// pattern in SKILL.md §5: a stalled server cannot hang the loop while a payment
// reservation is held. The timer stays armed through the body read, and a
// non-JSON error body is guarded so it cannot hide the HTTP status.
const REQUEST_TIMEOUT_MS = 10_000;

async function request(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

const anonStats = async () => (await request(`${ORIGIN}/api/x402/stats`)).json;

// ── 1. free index: what can be paid for, at what price, on which networks ────

const { json: index } = await request(`${ORIGIN}/api/agents`);
console.log(`Pro Yield paid rail — $${index.price_usd.all}/call`);
console.log(`networks advertised: ${index.networks.map((n) => n.label).join(", ")}`);
const payable = index.networks.find((n) => n.network === TARGET_NETWORK);
if (!payable) throw new Error(`${TARGET_NETWORK} is not advertised by /api/agents`);

// ── 2. fetch unpaid -> 402 challenge ────────────────────────────────────────

assertPinned(RESOURCE, "resource");
const { res: res402 } = await request(RESOURCE, {
  headers: { accept: "application/json" },
  redirect: "error",
});
if (res402.status !== 402) throw new Error(`expected 402, got ${res402.status}`);
const challenge = b64d(res402.headers.get("payment-required"));
const terms = challenge.accepts.find((a) => a.network === TARGET_NETWORK);
if (!terms) throw new Error(`challenge does not accept ${TARGET_NETWORK}`);
console.log(`challenge x402Version=${challenge.x402Version} · ${terms.amount} atomic units`);

// ── 3. budget + allowlist check BEFORE signing ──────────────────────────────
//
// Threat model: everything in the 402 challenge — `payTo`, `asset`, `amount`,
// `network` — is supplied by the resource server. Comparing two responses from
// that same server is not authorization, so on its own this check lets a
// compromised or hostile endpoint redirect the payment to a token or address
// the caller never approved. Pin the recipients caller-side with
// PROYIELD_ALLOWED_PAY_TO (comma-separated; `payTo` or `payTo@asset` to bind the two)
// and the challenge simply cannot move the money anywhere else. Unset, the
// example still runs — it is a worked example, not a wallet — but warns.

const PAYTO_ALLOW = (process.env.PROYIELD_ALLOWED_PAY_TO ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function assertCallerApproved(terms) {
  if (PAYTO_ALLOW.length === 0) {
    console.warn(
      "warning: PROYIELD_ALLOWED_PAY_TO is unset — signing the payTo/asset the server sent. " +
        "Pin them caller-side when the resource server is not trusted."
    );
    return;
  }
  const payTo = String(terms.payTo).toLowerCase();
  const asset = String(terms.asset).toLowerCase();
  const approved = PAYTO_ALLOW.some((entry) => {
    const [allowPayTo, allowAsset] = entry.toLowerCase().split("@");
    return allowPayTo === payTo && (!allowAsset || allowAsset === asset);
  });
  if (!approved) {
    throw new Error(
      `payTo ${terms.payTo} / asset ${terms.asset} is not in PROYIELD_ALLOWED_PAY_TO — refusing to sign`
    );
  }
}

const amount = BigInt(terms.amount);
if (amount > PER_CALL_CAP_ATOMIC) throw new Error(`price ${amount} exceeds per-call cap`);
const net = index.networks.find((n) => n.network === terms.network);
if (net.asset.toLowerCase() !== terms.asset.toLowerCase()) throw new Error("asset mismatch");

// This example implements the EVM (EIP-3009) signer path only. Solana is
// advertised by the API but needs an SPL `TransferChecked` signer, which is not
// implemented here — fail before signing rather than at the token address.
if (!Object.hasOwn(CHAIN_IDS, terms.network)) {
  throw new Error(
    `${terms.network} has no signer in this example: it covers EVM networks only ` +
      "(Solana requires an SPL TransferChecked path that is not implemented here)"
  );
}

assertCallerApproved(terms);
console.log(`payTo ${terms.payTo} · asset ${terms.asset} · cap ok`);

// ── 4. sign a fresh EIP-3009 authorization (key never leaves the signer) ────

const KEY = process.env.PROYIELD_PAYER_KEY;
if (!KEY) throw new Error("set PROYIELD_PAYER_KEY");
const account = privateKeyToAccount(KEY);
const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: account.address,
  to: terms.payTo,
  value: terms.amount,
  validAfter: String(now - 600),
  validBefore: String(now + Number(terms.maxTimeoutSeconds ?? 300) - 60),
  nonce: "0x" + randomBytes(32).toString("hex"), // fresh every call — replays 409
};
const signature = await account.signTypedData({
  domain: {
    name: terms.extra.name, // "USD Coin"
    version: terms.extra.version, // "2"
    chainId: CHAIN_IDS[terms.network],
    verifyingContract: terms.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: authorization,
});

// ── 5. retry the SAME url with PAYMENT-SIGNATURE ────────────────────────────

const statsBefore = await anonStats();
const envelope = b64e({
  x402Version: 2,
  accepted: terms,
  payload: { signature, authorization },
  resource: challenge.resource,
});
const { res: paid, json: body } = await request(RESOURCE, {
  headers: { accept: "application/json", "PAYMENT-SIGNATURE": envelope },
  redirect: "error",
});
const receiptHeader = paid.headers.get("payment-response");
const receipt = receiptHeader ? tryB64d(receiptHeader) : null;
console.log(`HTTP ${paid.status}${receipt ? " + PAYMENT-RESPONSE" : ""}`);

// ── 6. settlement evidence: this call's receipt is primary, the tally is not ─
//
// /api/x402/stats aggregates EVERY payer, so its delta cannot prove that this
// call settled: a concurrent payer pushes it past one, and a failed purchase can
// still sit inside a +1 window. The authoritative evidence is this response's own
// base64 PAYMENT-RESPONSE receipt — `success`, the settled `network`, and the
// `transaction`. A 200 without a readable receipt is UNCONFIRMED, never success
// (the skill's own rule, §7). The tally is read only as supporting information.

if (paid.status === 409) throw new Error(body.error ?? "409 payment_replay"); // already settled: never blind-retry
if (paid.status !== 200) throw new Error(`paid retry failed: HTTP ${paid.status}${body.error ? ` (${body.error})` : ""}`);
if (!receipt) throw new Error("settlement unconfirmed: 200 without a readable PAYMENT-RESPONSE receipt");
if (receipt.success !== true) throw new Error(`settlement unconfirmed: receipt success=${receipt.success}`);
if (receipt.network !== terms.network) throw new Error(`receipt network ${receipt.network} ≠ signed network ${terms.network}`);
if (!receipt.transaction) throw new Error("settlement unconfirmed: receipt carries no transaction hash");
console.log(`settled on ${receipt.network}: ${receipt.transaction}`);

// Cross-check only. The aggregate counts all payers, so a jump greater than one
// means a concurrent payer settled in this window — note it, don't throw — and a
// flat read is not evidence against the receipt we just validated.
const statsAfter = await anonStats();
const delta = statsAfter.calls_settled - statsBefore.calls_settled;
const received = statsAfter.total_received_usdc - statsBefore.total_received_usdc;
console.log(
  `tally cross-check ${statsBefore.calls_settled} -> ${statsAfter.calls_settled} (+${delta}, ` +
    `${received.toFixed(3)} USDC)`
);
if (delta > 1) {
  console.warn(`note: aggregate tally advanced by ${delta} — concurrent payers settled in this window`);
}
if (delta <= 0) {
  console.warn("note: aggregate tally did not move in this window — aggregate reads can lag; the receipt above is this call's evidence");
}

// The body is the resource payload. Rates are historical, sourced reads:
// as_of is when they were measured, generated_at is when this response was built.
console.log(`as_of ${body.as_of} · kind ${body.kind} · spent $${PRICE_USDC}`);
