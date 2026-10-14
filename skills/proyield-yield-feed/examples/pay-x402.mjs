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
//   * a 2xx whose body cannot be read is reported as a read failure — a failed
//     read never degrades into an empty object that looks like data
//   * a non-OK response from a required free read (the index) is thrown with its
//     HTTP status — a 429/5xx is an error, never an empty object or an error
//     payload handed to the caller as a reading
//   * the stats tally is a cross-check, so its reads are best-effort: a 429/5xx
//     there is reported and skipped, and can never suppress the purchase summary
//     of a payment that already settled
//   * the 402 challenge is read from the `PAYMENT-REQUIRED` header, and from the
//     response body's v1 `accepts[]` (normalized) when that header is absent
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
// reservation is held. The timer stays armed through the body read.
//
// Body-read policy — a non-OK read and an OK read are not the same thing:
//   * non-OK: a non-JSON error body (an HTML proxy page, an empty 409) must not
//     hide the HTTP status, so it falls back to {} and the caller branches on
//     res.status.
//   * OK: a 2xx whose body cannot be read (timeout mid-body, non-JSON proxy page)
//     is a real failure. It is returned as `readError` and surfaced by the
//     caller, never degraded to {} — {} would print as "no reading" over data
//     that never arrived, and on the paid call it could hide a discarded body
//     behind a settlement report.
const REQUEST_TIMEOUT_MS = 10_000;

async function request(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    try {
      return { res, json: await res.json(), readError: null };
    } catch (err) {
      if (!res.ok) return { res, json: {}, readError: null };
      return {
        res,
        json: null,
        readError: `response read failed: HTTP ${res.status} body was not readable JSON (${err.message})`,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

// For reads whose body is required: a read that produced no data is an error,
// not an empty object — and neither is an error status. A 429/5xx from a
// required read (the index) is rejected here with the HTTP status (plus the
// parsed `error`/`code` when the body carried one), so a rate-limit or an
// upstream outage can never reach a caller as `{}` or as error JSON wearing the
// shape of a reading. The paid retry deliberately does NOT go through this
// helper: it reads its settlement receipt off the response and keeps its own
// status handling (409 = already settled, never a blind retry). The stats tally
// is read through here too, but its own call site catches this throw (readTally)
// — a failed cross-check is reported and skipped, never allowed to abort a
// completed purchase.
async function requestJson(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { res, json, readError } = await request(url, init, timeoutMs);
  if (readError) throw new Error(readError);
  if (!res.ok) {
    const payload = json && typeof json === "object" ? (json.error ?? json.code) : undefined;
    const detail =
      payload == null ? "" : `: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
    throw new Error(`HTTP ${res.status} for ${url}${detail}`);
  }
  return { res, json };
}

const anonStats = async () => (await requestJson(`${ORIGIN}/api/x402/stats`)).json;

// The tally is a cross-check, never settlement evidence — `/api/x402/stats`
// aggregates every payer, so it cannot prove that THIS call settled (§6). Its
// reads are therefore best-effort: `requestJson()` still throws on a 429/5xx,
// and this is the one place that catches it. A tally that cannot be read is
// reported and the flow continues, because a failed cross-check must never
// suppress the purchase summary of a payment that already settled.
async function readTally() {
  try {
    return await anonStats();
  } catch (err) {
    console.warn(`tally unavailable: ${err.message} — cross-check skipped`);
    return null;
  }
}

// ── 1. free index: what can be paid for, at what price, on which networks ────

const { json: index } = await requestJson(`${ORIGIN}/api/agents`);
console.log(`Pro Yield paid rail — $${index.price_usd.all}/call`);
console.log(`networks advertised: ${index.networks.map((n) => n.label).join(", ")}`);
const payable = index.networks.find((n) => n.network === TARGET_NETWORK);
if (!payable) throw new Error(`${TARGET_NETWORK} is not advertised by /api/agents`);

// ── 2. fetch unpaid -> 402 challenge ────────────────────────────────────────
//
// §6 documents two artifacts for the challenge: the base64 `PAYMENT-REQUIRED`
// response header (v2 shape) and a JSON body with `x402Version: 1`. Prefer the
// header, but keep the parsed body and fall back to its `accepts[]` when the
// header is absent or unreadable — a documented body-only 402 must not die at
// `b64d(null)` before selection or signing. The body entry is v1-shaped, so it is
// normalized into what the signing/envelope code below expects (`maxAmountRequired`
// -> `amount`, plus the EIP-712 `extra` and `resource` the v2 header carries)
// rather than handed over raw as `terms`.

assertPinned(RESOURCE, "resource");
const { res: res402, json: body402 } = await request(RESOURCE, {
  headers: { accept: "application/json" },
  redirect: "error",
});
if (res402.status !== 402) throw new Error(`expected 402, got ${res402.status}`);

// The v1 body entry carries `maxAmountRequired` instead of `amount` and has no
// `extra`, so it is converted to the v2 accept shape the signing/envelope code
// expects: `maxAmountRequired` is consumed into `amount` (never left on `terms`),
// the EIP-712 domain comes from the documented USDC parameters when the challenge
// omits it (a v2 header's own `extra` always wins), and the entry's `resource`
// fills the envelope's resource. `amount` stays a string — the cap check does the BigInt.
const USDC_EXTRA = { name: "USD Coin", version: "2" };
const normalizeV1Accept = ({ maxAmountRequired, amount, extra, resource, ...rest }) => ({
  ...rest,
  amount: String(maxAmountRequired ?? amount),
  extra: extra ?? USDC_EXTRA,
  resource: resource ?? RESOURCE,
});

const headerChallenge = tryB64d(res402.headers.get("payment-required"));
const challenge = headerChallenge ?? {
  x402Version: body402?.x402Version ?? 1,
  resource: body402?.resource ?? RESOURCE,
  accepts: (body402?.accepts ?? []).map(normalizeV1Accept),
};
if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
  throw new Error("402 carried no challenge: no readable PAYMENT-REQUIRED header and no accepts[] body");
}
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
    const [allowPayTo, allowAsset] = entry
      .toLowerCase()
      .split("@")
      .map((part) => part.trim());
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

const statsBefore = await readTally(); // best-effort: a down tally must not block the payment
const envelope = b64e({
  x402Version: 2,
  accepted: terms,
  payload: { signature, authorization },
  resource: challenge.resource,
});
const { res: paid, json: body, readError: paidReadError } = await request(RESOURCE, {
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
//
// The same rule applies to the body: a settled 200 whose body cannot be read is a
// settlement with NO data, reported as such below — never a quiet "spent" line.

if (paid.status === 409) throw new Error(body?.error ?? "409 payment_replay"); // already settled: never blind-retry
if (paid.status !== 200) throw new Error(`paid retry failed: HTTP ${paid.status}${body?.error ? ` (${body.error})` : ""}`);
if (!receipt) throw new Error("settlement unconfirmed: 200 without a readable PAYMENT-RESPONSE receipt");
if (receipt.success !== true) throw new Error(`settlement unconfirmed: receipt success=${receipt.success}`);
if (receipt.network !== terms.network) throw new Error(`receipt network ${receipt.network} ≠ signed network ${terms.network}`);
if (!receipt.transaction) throw new Error("settlement unconfirmed: receipt carries no transaction hash");
console.log(`settled on ${receipt.network}: ${receipt.transaction}`);

// The money moved, but the thing it bought did not arrive. Report the settlement
// (above) and flag the data as unread — the one outcome this example must never
// print as success.
if (paidReadError) {
  throw new Error(
    `${paidReadError} — settlement ${receipt.transaction} on ${receipt.network} stands, but the purchased data is UNREAD`
  );
}

// Cross-check only, and best-effort. The aggregate counts all payers, so a jump
// greater than one means a concurrent payer settled in this window — note it,
// don't throw — and a flat read is not evidence against the receipt we just
// validated. A tally read that fails (429/5xx) is reported as unavailable by
// readTally() and the cross-check is simply skipped: the purchase summary below
// is the point of this example and is never suppressed by it.
const statsAfter = await readTally();
if (!statsBefore || !statsAfter) {
  console.warn(
    "tally cross-check skipped: the tally was unreadable in this window — the receipt above is this call's evidence"
  );
} else {
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
}

// The body is the resource payload. Rates are historical, sourced reads:
// as_of is when they were measured, generated_at is when this response was built.
console.log(`as_of ${body.as_of} · kind ${body.kind} · spent $${PRICE_USDC}`);
