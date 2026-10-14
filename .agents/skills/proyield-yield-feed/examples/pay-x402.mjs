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
//   * settlement is confirmed against /api/x402/stats, not just the receipt header
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

// ── guard rails ──────────────────────────────────────────────────────────────

function assertPinned(url, label) {
  const u = new URL(url);
  if (u.origin !== ORIGIN) throw new Error(`${label}: refusing non-pinned origin ${u.origin}`);
  return u;
}

const anonStats = async () => (await fetch(`${ORIGIN}/api/x402/stats`)).json();

// ── 1. free index: what can be paid for, at what price, on which networks ────

const index = await (await fetch(`${ORIGIN}/api/agents`)).json();
console.log(`Pro Yield paid rail — $${index.price_usd.all}/call`);
console.log(`networks advertised: ${index.networks.map((n) => n.label).join(", ")}`);
const payable = index.networks.find((n) => n.network === TARGET_NETWORK);
if (!payable) throw new Error(`${TARGET_NETWORK} is not advertised by /api/agents`);

// ── 2. fetch unpaid -> 402 challenge ────────────────────────────────────────

assertPinned(RESOURCE, "resource");
const res402 = await fetch(RESOURCE, { headers: { accept: "application/json" }, redirect: "error" });
if (res402.status !== 402) throw new Error(`expected 402, got ${res402.status}`);
const challenge = b64d(res402.headers.get("payment-required"));
const terms = challenge.accepts.find((a) => a.network === TARGET_NETWORK);
if (!terms) throw new Error(`challenge does not accept ${TARGET_NETWORK}`);
console.log(`challenge x402Version=${challenge.x402Version} · ${terms.amount} atomic units`);

// ── 3. budget + allowlist check BEFORE signing ──────────────────────────────

const amount = BigInt(terms.amount);
if (amount > PER_CALL_CAP_ATOMIC) throw new Error(`price ${amount} exceeds per-call cap`);
const net = index.networks.find((n) => n.network === terms.network);
if (net.asset.toLowerCase() !== terms.asset.toLowerCase()) throw new Error("asset mismatch");
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
const paid = await fetch(RESOURCE, {
  headers: { accept: "application/json", "PAYMENT-SIGNATURE": envelope },
  redirect: "error",
});
const body = await paid.json();
const receipt = paid.headers.get("payment-response");
console.log(`HTTP ${paid.status}${receipt ? " + PAYMENT-RESPONSE" : ""}`);
if (receipt) {
  const r = b64d(receipt);
  console.log(`settled on ${r.network}: ${r.transaction}`);
}
if (paid.status === 409) throw new Error(body.error); // already settled: never blind-retry

// ── 6. confirm independently: the server-side tally must advance by one ─────

const statsAfter = await anonStats();
const delta = statsAfter.calls_settled - statsBefore.calls_settled;
console.log(
  `tally ${statsBefore.calls_settled} -> ${statsAfter.calls_settled} (+${delta}, ` +
    `${(statsAfter.total_received_usdc - statsBefore.total_received_usdc).toFixed(3)} USDC)`
);
if (delta !== 1) throw new Error("settlement not confirmed by /api/x402/stats");

// The body is the resource payload. Rates are historical, sourced reads:
// as_of is when they were measured, generated_at is when this response was built.
console.log(`as_of ${body.as_of} · kind ${body.kind} · spent $${PRICE_USDC}`);
