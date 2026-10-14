// Pro Yield free read tier from JavaScript/TypeScript — no key, no signup, no payment.
// Run: node read-free.mjs  (Node 18+; uses the global fetch)
//
// Honest-data rules this example enforces:
//   * per-request timeout, so a rate-limited read cannot hang an agent loop
//   * 429 honoured via Retry-After
//   * errors[] surfaced as partial data rather than swallowed
//   * a 2xx whose body cannot be read surfaces as an error, never as "no reading"
//   * as_of carried alongside every rate, because as_of != generated_at
//   * null != 0: a missing reading prints "no reading", never 0

const ORIGIN = "https://pyd.fi";

async function readProYield(path, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ORIGIN}${path}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 5);
      throw new Error(`rate limited; retry after ${retryAfter}s`);
    }
    // Body-read policy — a non-OK read and an OK read are not the same thing:
    //   * non-OK: a non-JSON error body (e.g. HTML from a proxy) must not hide the
    //     HTTP status, so the read falls back to {} and the status is thrown below.
    //   * OK: a 2xx whose body cannot be read is a real failure. Falling back to {}
    //     here would print "no reading" — a broken read wearing the mask of a
    //     valid, empty answer — so it is surfaced instead.
    let body;
    try {
      body = await res.json();
    } catch (err) {
      if (res.ok) {
        throw new Error(
          `response read failed: HTTP ${res.status} body was not readable JSON (${err.message})`
        );
      }
      body = {};
    }
    // Partial failures arrive as HTTP 200 with a populated errors[] array.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      console.warn("partial data:", body.errors);
    }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const catalog = await readProYield("/api/yield/strategies");

console.log(
  `vault      ${catalog.vault?.address ?? "no reading"}  (${catalog.network?.name ?? "no reading"})`
);
console.log(`share px   ${catalog.vault?.share_price_usdc ?? "no reading"} USDC`);
console.log(`assets     ${catalog.vault?.total_assets_usdc ?? "no reading"} USDC`);
console.log(
  `caps       ${catalog.vault?.caps?.tvl_usdc ?? "no reading"} TVL / ` +
    `${catalog.vault?.caps?.per_user_usdc ?? "no reading"} per wallet / ` +
    `paused: ${catalog.vault?.caps?.deposits_paused ?? "no reading"}`
);
console.log(
  `blend      ${catalog.blend?.target_pct ?? "no reading"}% — guaranteed: ` +
    `${catalog.blend?.guarantee ?? "no reading"} (${catalog.blend?.note ?? "no reading"})`
);
console.log(
  `as_of      ${catalog.as_of ?? "no reading"}   generated_at ${catalog.generated_at ?? "no reading"}`
);
console.log(`source     ${catalog.venue_rates?.source ?? "no reading"}`);

console.log("\nsleeves (live reads, not forecasts):");
for (const s of catalog.strategies ?? []) {
  // null means "no reading" — never print it as 0.
  const rate = s.apy_pct == null ? "no live read" : `${s.apy_pct}%`;
  console.log(`  ${(s.kind ?? "?").padEnd(9)} ${(s.name ?? "?").padEnd(32)} ${rate}`);
}

console.log("\ncurated core venues:");
for (const r of catalog.venue_rates?.core_rates ?? []) {
  console.log(`  ${String(r.apy ?? "no reading").padEnd(9)} ${(r.chain ?? "?").padEnd(10)} ${r.full ?? ""}`);
}

// A position read is one free call. Note the vault is a guarded beta with
// code-enforced caps and no completed external audit — report it that way.
const pos = await readProYield(
  "/api/yield/positions?address=0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1"
);
console.log(
  `\nposition value ${pos.vault?.value_usdc ?? "no reading"} USDC · ` +
    `shares ${pos.vault?.shares ?? "no reading"}`
);
