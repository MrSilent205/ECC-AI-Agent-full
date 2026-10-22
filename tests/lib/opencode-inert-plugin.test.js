'use strict';

/**
 * Contract tests for the inert OpenCode plugin ECC materializes when hook
 * consent is not enabled.
 *
 * OpenCode discovers every `plugins/*.{ts,js}` file on its own, so the inert
 * stub is loaded by the host on every boot no matter what the user answered.
 * It therefore has to satisfy BOTH plugin loader contracts:
 *
 *   v1 loader (`readV1Plugin`, node-BTHdWE4q.js:156305) â€” the default export
 *     must be a plain object carrying `server()` (or `tui()`, never both).
 *   v2 loader (`PluginModule`, node-BTHdWE4q.js:168858) â€” the default export
 *     must be a plain object carrying `id` and `setup`.
 *
 * A bare `export default async () => ({})` satisfies neither: the v1 loader
 * rejects it as "Plugin export is not a function" and the v2 loader rejects it
 * as a legacy v1 export. The stub must also stay inert â€” no imports (module
 * initialization alone has effects) and no registered hooks.
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

/** Mirror of the v1 loader contract (readV1Plugin). */
function readV1Plugin(mod, spec, kind, mode = 'strict') {
  const value = mod.default;
  if (!isRecord(value)) {
    if (mode === 'detect') return undefined;
    throw new TypeError(`Plugin ${spec} must default export an object with ${kind}()`);
  }
  if (mode === 'detect' && !('id' in value) && !('server' in value) && !('tui' in value)) {
    return undefined;
  }
  const server = 'server' in value ? value.server : undefined;
  const tui = 'tui' in value ? value.tui : undefined;
  if (server !== undefined && typeof server !== 'function') {
    throw new TypeError(`Plugin ${spec} has invalid server export`);
  }
  if (tui !== undefined && typeof tui !== 'function') {
    throw new TypeError(`Plugin ${spec} has invalid tui export`);
  }
  if (server !== undefined && tui !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`);
  }
  if (server === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`);
  }
  return value;
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
    console.log(`  âœ“ ${name}`);
    return true;
  } catch (error) {
    console.log(`  âœ— ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing the inert OpenCode plugin contract ===\n');
  let passed = 0;
  let failed = 0;

  const { content, mod } = await importInertPlugin();

  if (await test('the inert plugin satisfies the v1 loader contract', () => {
    const plugin = readV1Plugin(mod, 'inert-plugin.ts', 'server', 'detect');
    assert.ok(plugin, 'The v1 loader must not ignore the inert plugin');
    assert.strictEqual(typeof plugin.server, 'function');
    assert.ok(!('tui' in plugin), 'The v1 loader rejects a plugin exporting both server() and tui()');
  })) passed++; else failed++;

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
    const hooks = await mod.default.server({ client: {}, directory: process.cwd() }, {});
    assert.ok(isRecord(hooks), 'The v1 server() must return a hook object');
    assert.deepStrictEqual(Object.keys(hooks), [], 'The inert plugin must not register hooks');
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
