'use strict';

// Execute the canonical and translated seller replay guard offline. Redis and
// @solana/kit are replaced with in-memory stubs; node:crypto is real. No
// network, key, or real payment is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '../..');
const DOCS = [
  'skills/agent-payment-x402/SKILL.md',
  'docs/ja-JP/skills/agent-payment-x402/SKILL.md',
  'docs/zh-CN/skills/agent-payment-x402/SKILL.md',
];
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Wire format: compact-u16 signature count (one byte below 128), 64 bytes per
// signature, then the message. Enough of a decoder for the stubbed kit.
const kit = {
  getBase64Encoder: () => ({ encode: text => new Uint8Array(Buffer.from(text, 'base64')) }),
  getTransactionDecoder: () => ({
    decode: bytes => ({ messageBytes: bytes.slice(1 + 64 * bytes[0]) }),
  }),
};

function harness(doc, mode = 'ok') {
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
  const blocks = [...text.matchAll(/```typescript\n([\s\S]*?)\n```/g)];
  const block = blocks.find(match => match[1].includes('async function replayGuard('));
  assert.ok(block, 'document must retain a runnable seller replay guard');
  const store = new Set();
  const redis = {
    options: null, listeners: {}, sets: 0, badOptions: 0, lastUntil: 0,
    on(event, fn) { this.listeners[event] = fn; return this; },
    connect: () => Promise.reject(new Error('ECONNREFUSED')),
    async set(key, value, opts) {
      this.sets++;
      // Recorded, not asserted: the guard's own fail-open catch would hide a throw.
      if (opts.condition !== 'NX' || opts.expiration?.type !== 'EXAT') this.badOptions++;
      this.lastUntil = opts.expiration?.value;
      if (mode === 'offline') throw new Error('The client is offline');
      if (mode === 'hang') return new Promise(() => {});
      if (store.has(key)) return null;
      store.add(key);
      return 'OK';
    },
  };
  const modules = {
    'node:crypto': crypto,
    '@solana/kit': kit,
    redis: { createClient: options => { redis.options = options; return redis; } },
  };
  const source = `${block[1]}\nmodule.exports = { claimKey, replayGuard };`;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.equal((compiled.diagnostics || []).length, 0);
  const context = vm.createContext({
    require: name => modules[name], module: { exports: {} }, exports: {},
    Buffer, Promise, setTimeout, console: { warn() {} }, process: { env: {} },
  });
  new vm.Script(compiled.outputText, { filename: doc }).runInContext(context);
  const call = async header => {
    const out = { status: 0, body: null, ran: false };
    const res = {
      status(code) { out.status = code; return this; },
      json(body) { out.body = body; return this; },
    };
    const req = { get: name => (name === 'payment-signature' ? header : undefined) };
    await context.module.exports.replayGuard(req, res, () => { out.ran = true; });
    return out;
  };
  return { ...context.module.exports, call, redis };
}

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
function evm(nonce, { asset = USDC_BASE, indent, validBefore } = {}) {
  return b64(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:8453', asset },
    payload: { signature: '0x00', authorization: { from: '0xAbC0000000000000000000000000000000000001', nonce, validBefore } },
  }, null, indent));
}
function svm(feeSlotByte, message = 'payer-signed-message') {
  const tx = Buffer.concat([Buffer.from([2]), Buffer.alloc(64, feeSlotByte), Buffer.alloc(64, 7), Buffer.from(message)]);
  return b64({ x402Version: 2, accepted: { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
    payload: { transaction: tx.toString('base64') } });
}

const tests = [];
for (const doc of DOCS) {
  const add = (name, test) => tests.push([`${doc}: ${name}`, test]);
  add('runs the route once for three concurrent copies of one authorization', async () => {
    const h = harness(doc);
    const results = await Promise.all([h.call(evm('0x01')), h.call(evm('0x01')), h.call(evm('0x01'))]);
    assert.equal(results.filter(r => r.ran).length, 1);
    const refused = results.filter(r => r.status === 402);
    assert.equal(refused.length, 2);
    for (const r of refused) assert.equal(r.body.error, 'payment_replayed');
    assert.equal(h.redis.badOptions, 0, 'claims must use SET NX with an absolute expiry');
  });
  add('keys EVM payments on asset, payer and nonce, not header bytes', async () => {
    const h = harness(doc);
    assert.equal(h.claimKey(evm('0x01')), h.claimKey(evm('0x01', { indent: 2 })));
    assert.notEqual(h.claimKey(evm('0x01')), h.claimKey(evm('0x02')));
    assert.notEqual(h.claimKey(evm('0x01')), h.claimKey(evm('0x01', { asset: '0x0000000000000000000000000000000000000001' })));
  });
  add('keys Solana payments on the signed message, ignoring the fee-payer slot', async () => {
    const h = harness(doc);
    assert.equal(h.claimKey(svm(0)), h.claimKey(svm(9)));
    assert.notEqual(h.claimKey(svm(0)), h.claimKey(svm(0, 'another-message')));
    assert.match(h.claimKey('not base64 json'), /^x402:raw:/);
  });
  add('loads without waiting on the store and never crashes on client errors', async () => {
    const h = harness(doc);
    assert.equal(h.redis.options.disableOfflineQueue, true);
    assert.ok(h.redis.options.commandsQueueMaxLength > 0, 'pending claims must be bounded');
    assert.equal(typeof h.redis.listeners.error, 'function');
    h.redis.listeners.error(new Error('socket closed'));
  });
  add('keeps a claim until the signed authorization expires', async () => {
    const h = harness(doc);
    const now = () => Math.floor(Date.now() / 1000);
    await h.call(evm('0x31', { validBefore: String(now() + 3600) }));
    assert.ok(Math.abs(h.redis.lastUntil - (now() + 3660)) <= 2, `1 h authorization: ${h.redis.lastUntil - now()} s`);
    await h.call(evm('0x32', { validBefore: String(now() + 60) }));
    assert.ok(Math.abs(h.redis.lastUntil - (now() + 900)) <= 2, `short authorization keeps the floor: ${h.redis.lastUntil - now()} s`);
    await h.call(evm('0x33', { validBefore: (2n ** 256n).toString() }));
    assert.ok(Math.abs(h.redis.lastUntil - (now() + 366 * 86400)) <= 2, 'absurd validBefore is capped');
    await h.call(svm(3));
    assert.ok(Math.abs(h.redis.lastUntil - (now() + 900)) <= 2, 'Solana uses the floor');
  });
  add('fails open when the store is offline', async () => {
    const h = harness(doc, 'offline');
    const [a, b] = [await h.call(evm('0x01')), await h.call(evm('0x01'))];
    assert.ok(a.ran && b.ran);
  });
  add('fails open when the store hangs, within the claim timeout', async () => {
    const h = harness(doc, 'hang');
    const started = Date.now();
    assert.ok((await h.call(evm('0x01'))).ran);
    assert.ok(Date.now() - started < 1000);
  });
  add('stores nothing for oversized or missing headers', async () => {
    const h = harness(doc);
    const big = await h.call('A'.repeat(20_000));
    assert.equal(big.status, 431);
    assert.equal(big.ran, false);
    assert.ok((await h.call(undefined)).ran);
    assert.equal(h.redis.sets, 0);
  });
}

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });
// The guard's claim timer is unref'd, as a server's should be; hold the event
// loop open so the hanging-store case is awaited instead of exiting early.
const keepAlive = setInterval(() => {}, 1000);
(async () => {
  let passed = 0;
  for (const [name, test] of tests) {
    try { await test(); passed++; console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}: ${error.message}`); }
  }
  await new Promise(resolve => setImmediate(resolve));
  if (unhandled) console.error(`FAIL unhandled promise rejections: ${unhandled}`);
  console.log(`Passed: ${passed}\nFailed: ${tests.length - passed + unhandled}`);
  process.exitCode = passed === tests.length && !unhandled ? 0 : 1;
  clearInterval(keepAlive);
})();
