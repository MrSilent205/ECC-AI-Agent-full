// Pro Yield free read tier from JavaScript/TypeScript — no key, no signup, no payment.
// Run: node read-free.mjs  (Node 18+; uses the global fetch)
//
// Honest-data rules this example enforces:
//   * per-request timeout, so a rate-limited read cannot hang an agent loop
//   * 429 honoured via Retry-After
//   * errors[] surfaced as partial data rather than swallowed
//   * as_of carried alongside every rate, because as_of != generated_at

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
    const body = await res.json();
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

console.log(`vault      ${catalog.vault.address}  (${catalog.network.name})`);
console.log(`share px   ${catalog.vault.share_price_usdc} USDC`);
console.log(`assets     ${catalog.vault.total_assets_usdc} USDC`);
console.log(
  `caps       ${catalog.vault.caps.tvl_usdc} TVL / ` +
    `${catalog.vault.caps.per_user_usdc} per wallet / ` +
    `paused: ${catalog.vault.caps.deposits_paused}`
);
console.log(
  `blend      ${catalog.blend.target_pct}% — guaranteed: ${catalog.blend.guarantee} ` +
    `(${catalog.blend.note})`
);
console.log(`as_of      ${catalog.as_of}   generated_at ${catalog.generated_at}`);
console.log(`source     ${catalog.venue_rates.source}`);

console.log("\nsleeves (live reads, not forecasts):");
for (const s of catalog.strategies) {
  // null means "no reading" — never print it as 0.
  const rate = s.apy_pct === null ? "no live read" : `${s.apy_pct}%`;
  console.log(`  ${s.kind.padEnd(9)} ${s.name.padEnd(32)} ${rate}`);
}

console.log("\ncurated core venues:");
for (const r of catalog.venue_rates.core_rates) {
  console.log(`  ${String(r.apy).padEnd(9)} ${r.chain.padEnd(10)} ${r.full}`);
}

// A position read is one free call. Note the vault is a guarded beta with
// code-enforced caps and no completed external audit — report it that way.
const pos = await readProYield(
  "/api/yield/positions?address=0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1"
);
console.log(`\nposition value ${pos.vault.value_usdc} USDC · shares ${pos.vault.shares}`);
