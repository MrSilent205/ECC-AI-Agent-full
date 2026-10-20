'use strict';

// Tests for the typescript-patterns skill: the SKILL.md examples must match
// their strict-TypeScript claims, and JS mirrors of the example logic must
// behave as documented. Type-level proof lives in
// tests/fixtures/typescript-patterns (tsc --strict --noUncheckedIndexedAccess).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'typescript-patterns', 'SKILL.md');
const skill = fs.readFileSync(skillPath, 'utf8');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(
        () => { passed += 1; console.log(`  ✓ ${name}`); },
        error => { failed += 1; console.log(`  ✗ ${name}`); console.log(`    ${error.message}`); }
      ));
      return;
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

console.log('\n=== TypeScript patterns skill tests ===\n');

// ---- Skill document claims ---------------------------------------------

test('loadUser validates instead of asserting the payload', () => {
  assert.doesNotMatch(skill, /response\.json\(\) as Promise<User>/);
  assert.match(skill, /function isUser\(value: unknown\): value is User/);
});

test('config example validates every consumed field', () => {
  assert.doesNotMatch(skill, /value as Config/);
  assert.match(skill, /toPositiveInt\(raw\.timeout/);
  assert.match(skill, /toPositiveInt\(raw\.retries/);
  assert.match(skill, /DEFAULT_CONFIG/);
});

test('concurrency example narrows indexed access', () => {
  assert.doesNotMatch(skill, /mapper\(items\[index\]\)/);
  assert.match(skill, /Number\.isInteger\(limit\) \|\| limit < 1/);
  assert.match(skill, /noUncheckedIndexedAccess/);
});

test('async error prose states the real semantics', () => {
  assert.match(skill, /always surfaces throws as rejections/);
  assert.doesNotMatch(skill, /lets them escape as rejected promises inconsistently/);
});

// ---- JS mirrors of the documented logic --------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

const DEFAULT_CONFIG = { timeout: 30_000, retries: 3 };

function toPositiveInt(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`Expected ${field} to be a positive integer`);
  }
  return value;
}

function parseConfig(raw) {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
  return {
    timeout: raw.timeout === undefined ? DEFAULT_CONFIG.timeout : toPositiveInt(raw.timeout, 'timeout'),
    retries: raw.retries === undefined ? DEFAULT_CONFIG.retries : toPositiveInt(raw.retries, 'retries'),
  };
}

function isUser(value) {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || !('email' in value)) return false;
  const { id, email } = value;
  return typeof id === 'string' && id.length > 0
    && typeof email === 'string' && email.includes('@');
}

async function loadUser(userId, fetchJson) {
  const response = await fetchJson(`/users/${userId}`);
  if (!response.ok) {
    throw new Error(`Failed to load user ${userId}: ${response.status}`);
  }
  const data = await response.json();
  if (!isUser(data)) {
    throw new TypeError(`Invalid user payload for ${userId}`);
  }
  return data;
}

async function mapWithConcurrency(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Expected concurrency limit to be a positive integer, got: ${limit}`);
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await mapper(item);
    }
  });
  await Promise.all(workers);
  return results;
}

const okFetch = payload => async () => ({ ok: true, status: 200, json: async () => payload });
const badFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

// ---- parseConfig --------------------------------------------------------

test('parseConfig accepts a valid configuration', () => {
  assert.deepStrictEqual(parseConfig({ timeout: 1000, retries: 5 }), { timeout: 1000, retries: 5 });
});

test('parseConfig rejects a string-valued retries field', () => {
  assert.throws(() => parseConfig({ timeout: 1000, retries: '3' }), TypeError);
});

test('parseConfig applies declared defaults for missing fields', () => {
  assert.deepStrictEqual(parseConfig({}), { timeout: 30_000, retries: 3 });
  assert.deepStrictEqual(parseConfig(null), { timeout: 30_000, retries: 3 });
});

test('parseConfig rejects zero and negative values', () => {
  assert.throws(() => parseConfig({ timeout: 0, retries: 3 }), TypeError);
  assert.throws(() => parseConfig({ timeout: 1000, retries: -1 }), TypeError);
  assert.throws(() => parseConfig({ timeout: 1.5, retries: 3 }), TypeError);
});

// ---- loadUser / isUser ----------------------------------------------------

test('loadUser returns a valid user', async () => {
  const user = await loadUser('u_1', okFetch({ id: 'u_1', email: 'a@example.com' }));
  assert.deepStrictEqual(user, { id: 'u_1', email: 'a@example.com' });
});

test('loadUser rejects a response missing email', async () => {
  await assert.rejects(loadUser('u_1', okFetch({ id: 'u_1' })), TypeError);
});

test('loadUser rejects fields with incorrect types', async () => {
  await assert.rejects(loadUser('u_1', okFetch({ id: 1, email: 'a@example.com' })), TypeError);
  await assert.rejects(loadUser('u_1', okFetch({ id: 'u_1', email: 'not-an-email' })), TypeError);
});

test('loadUser rejects null, arrays, and other malformed payloads', async () => {
  await assert.rejects(loadUser('u_1', okFetch(null)), TypeError);
  await assert.rejects(loadUser('u_1', okFetch([{ id: 'u_1', email: 'a@example.com' }])), TypeError);
  await assert.rejects(loadUser('u_1', okFetch('oops')), TypeError);
});

test('loadUser rejects failed fetches and invalid JSON', async () => {
  await assert.rejects(loadUser('u_1', badFetch), /Failed to load user/);
  await assert.rejects(loadUser('u_1', async () => { throw new Error('bad json'); }), /bad json/);
});

// ---- mapWithConcurrency ----------------------------------------------------

test('mapWithConcurrency handles an empty input array', async () => {
  assert.deepStrictEqual(await mapWithConcurrency([], 4, async x => x), []);
});

test('mapWithConcurrency maps with a valid limit', async () => {
  assert.deepStrictEqual(await mapWithConcurrency([1, 2, 3], 2, async x => x * 2), [2, 4, 6]);
});

test('mapWithConcurrency accepts limits greater than the input length', async () => {
  assert.deepStrictEqual(await mapWithConcurrency([1, 2], 10, async x => x + 1), [2, 3]);
});

test('mapWithConcurrency rejects zero and negative limits', async () => {
  await assert.rejects(mapWithConcurrency([1], 0, async x => x), RangeError);
  await assert.rejects(mapWithConcurrency([1], -2, async x => x), RangeError);
});

test('mapWithConcurrency rejects fractional and non-finite limits', async () => {
  await assert.rejects(mapWithConcurrency([1], 1.5, async x => x), RangeError);
  await assert.rejects(mapWithConcurrency([1], NaN, async x => x), RangeError);
  await assert.rejects(mapWithConcurrency([1], Infinity, async x => x), RangeError);
});

test('mapWithConcurrency preserves order when mappers finish out of order', async () => {
  const delays = [30, 5, 15, 1];
  const out = await mapWithConcurrency([0, 1, 2, 3], 4, async x => {
    await new Promise(resolve => setTimeout(resolve, delays[x]));
    return x * 10;
  });
  assert.deepStrictEqual(out, [0, 10, 20, 30]);
});

test('mapWithConcurrency propagates mapper rejection', async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async x => { if (x === 2) throw new Error('boom'); return x; }),
    /boom/
  );
});

test('mapWithConcurrency never exceeds the configured limit', async () => {
  let active = 0;
  let maxActive = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async x => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return x;
  });
  assert.ok(maxActive <= 2, `peak concurrency ${maxActive} exceeded limit 2`);
  assert.ok(maxActive > 1, 'workers never overlapped; pool may be serial');
});

test('async functions surface throws as rejections, sync returns do not', async () => {
  async function asyncFails() { throw new Error('async'); }
  function lazyFails() { throw new Error('sync'); }
  await assert.rejects(asyncFails(), /async/);
  assert.throws(() => lazyFails(), /sync/);
});

Promise.allSettled(pending).then(() => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
});
