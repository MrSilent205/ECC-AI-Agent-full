'use strict';

/**
 * Contract tests for the inert OpenCode plugin ECC materializes when hook
 * consent is not enabled.
 *
 * OpenCode discovers every `plugins/*.{ts,js}` file on its own, so the inert
 * stub is loaded by the host on every boot no matter what the user answered.
 * This fork targets the OpenCode v2 plugin contract only: the default export
 * must be a plain object carrying `id` and `setup`.
 *
 * A bare `export default async () => ({})` is rejected by the v2 loader. The
 * stub must also stay inert - no imports (module initialization alone has
 * effects) and no registered hooks.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { getDisabledOpenCodePluginContent } = require('../../scripts/lib/install/hook-consent');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Mirror of the v2 loader contract (PluginModule struct). */
function readV2Plugin(mod, spec) {
  const value = mod.default;
  if (!isRecord(value)) {
    throw new TypeError(`Plugin ${spec} must default export an object`);
  }
  const hasEffect = 'effect' in value;
  const hasSetup = 'setup' in value;
  if (!hasEffect && !hasSetup) {
    throw new TypeError(`Plugin ${spec} must default export an object with setup()`);
  }
  if (hasEffect && typeof value.effect !== 'function') {
    throw new TypeError(`Plugin ${spec} has invalid effect export`);
  }
  if (hasSetup && typeof value.setup !== 'function') {
    throw new TypeError(`Plugin ${spec} has invalid setup export`);
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new TypeError(`Plugin ${spec} must default export an object with a non-empty id`);
  }
  return value;
}

async function importInertPlugin() {
  const content = getDisabledOpenCodePluginContent();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-inert-plugin-'));
  const file = path.join(dir, 'inert-plugin.mjs');
  fs.writeFileSync(file, content, 'utf8');
  try {
    return { content, mod: await import(pathToFileURL(file).href) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing the inert OpenCode plugin contract ===\n');
  let passed = 0;
  let failed = 0;

  const { content, mod } = await importInertPlugin();

  if (await test('the inert plugin satisfies the v2 loader contract', () => {
    const plugin = readV2Plugin(mod, 'inert-plugin.ts');
    assert.strictEqual(typeof plugin.setup, 'function');
    assert.strictEqual(typeof plugin.id, 'string');
    assert.ok(plugin.id.trim().length > 0);
  })) passed++; else failed++;

  if (await test('the inert plugin keeps the ECC plugin id', () => {
    assert.strictEqual(mod.default.id, 'ecc-hooks');
  })) passed++; else failed++;

  if (await test('the inert plugin registers no hooks and imports nothing', async () => {
    const calls = [];
    await mod.default.setup({
      tool: { hook: () => calls.push('tool'), transform: () => calls.push('transform') },
      event: { subscribe: () => calls.push('event') },
      shell: { hook: () => calls.push('shell') },
      session: { hook: () => calls.push('session') },
      permission: { hook: () => calls.push('permission') },
    });
    assert.deepStrictEqual(calls, [], 'The inert plugin must not register v2 hooks');
  })) passed++; else failed++;

  if (await test('the inert plugin has no imports and no side effects', () => {
    assert.ok(!/^\s*import\s/m.test(content), 'The inert plugin must not import the original module');
    assert.ok(!/require\s*\(/.test(content), 'The inert plugin must not require the original module');
    assert.ok(!/process\./.test(content), 'The inert plugin must not touch the process');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
