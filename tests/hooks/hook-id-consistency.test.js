'use strict';

/**
 * Regression tests for the SessionEnd hook-ID contract (Greptile P1 class).
 *
 * The runtime identifier passed to run-with-flags.js / lifecycle-hook-bootstrap.js
 * must equal the published identifier in hooks/hooks.metadata.json. Otherwise
 * ECC_DISABLED_HOOKS=<published-id> silently fails to disable the hook while
 * the operator believes it is off.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HOOKS_JSON = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
const METADATA_JSON = path.join(__dirname, '..', '..', 'hooks', 'hooks.metadata.json');
const { isHookEnabled } = require('../../scripts/lib/hook-flags');

let failures = 0;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

function runtimeHookIds(command) {
  const ids = new Set();
  for (const m of String(command).matchAll(/'([a-z][a-z0-9:_\-.]*)',\s*'scripts\/hooks\//g)) {
    ids.add(m[1]);
  }
  for (const m of String(command).matchAll(/ ([a-z][a-z0-9:_\-.]*)\s+scripts\/hooks\/[A-Za-z0-9_\-.]+\.js/g)) {
    ids.add(m[1]);
  }
  return [...ids];
}

console.log('\nhook-id consistency (SessionEnd)');

test('every SessionEnd runtime hook ID is published in metadata', () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.SessionEnd;
  const metadata = require(METADATA_JSON).entries.SessionEnd;
  const published = new Set(metadata.map(entry => entry.id));
  for (const entry of hooks) {
    for (const hook of entry.hooks || []) {
      for (const id of runtimeHookIds(hook.command)) {
        assert.ok(published.has(id), `runtime hook ID "${id}" has no metadata entry (ECC_DISABLED_HOOKS would silently miss it)`);
      }
    }
  }
});

test('every SessionEnd metadata ID has a runtime registration', () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.SessionEnd;
  const metadata = require(METADATA_JSON).entries.SessionEnd;
  const runtime = new Set();
  for (const entry of hooks) {
    for (const hook of entry.hooks || []) {
      for (const id of runtimeHookIds(hook.command)) runtime.add(id);
    }
  }
  for (const entry of metadata) {
    assert.ok(runtime.has(entry.id), `metadata ID "${entry.id}" has no runtime registration`);
  }
});

test('ECC_DISABLED_HOOKS disables the feedback hook by its published ID', () => {
  const env = { ECC_DISABLED_HOOKS: 'session:end:feedback' };
  assert.strictEqual(isHookEnabled('session:end:feedback', { env }), false);
  assert.strictEqual(isHookEnabled('session:end:feedback', { env: {} }), true);
});

test('feedback hook runs synchronously so SessionEnd stderr reaches the user', () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.SessionEnd;
  const all = hooks.flatMap(entry => entry.hooks || []);
  const feedback = all.filter(hook => String(hook.command).includes('success-feedback-prompt.js'));
  assert.strictEqual(feedback.length, 1, 'expected exactly one feedback registration');
  assert.notStrictEqual(feedback[0].async, true, 'async SessionEnd results are only delivered while the session runs');
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failures}`);
if (failures > 0) {
  console.log(`${failures} test(s) failed`);
  process.exit(1);
}

console.log('\nAll hook-id consistency tests passed');
