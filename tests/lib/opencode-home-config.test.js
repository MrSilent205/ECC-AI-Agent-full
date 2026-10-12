'use strict';

/**
 * Tests for the OpenCode home-config projection and the hook-runtime package
 * closure used by the opencode-home install target.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectOpenCodeHomeConfig, OPENCODE_HOME_CONFIG_TRANSFORM } = require('../../scripts/lib/install/opencode-home-config');
const { transformInstallContent } = require('../../scripts/lib/install/content-transform');
const opencodeHome = require('../../scripts/lib/install/opencode-home-config');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

console.log('\n=== Testing OpenCode home config ===\n');

test('projection keeps only agents and commands', () => {
  const projected = JSON.parse(
    projectOpenCodeHomeConfig(
      JSON.stringify({
        $schema: 'x',
        default_agent: 'build',
        instructions: ['a'],
        plugin: ['./plugins'],
        skills: { paths: ['skills'] },
        permission: { 'mcp_*': 'ask' },
        agent: { build: { mode: 'primary' } },
        command: { plan: { template: 't' } }
      })
    )
  );
  assert.deepStrictEqual(projected, { agent: { build: { mode: 'primary' } }, command: { plan: { template: 't' } } });
});

test('projection of the repository template has no arrays', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '.opencode', 'opencode.json'), 'utf8');
  const projected = projectOpenCodeHomeConfig(template);
  const hasArray = value => Array.isArray(value) || (value && typeof value === 'object' && Object.values(value).some(hasArray));
  assert.strictEqual(hasArray(JSON.parse(projected)), false, 'merging must never replace user-owned arrays');
});

test('content transform dispatches to the same projection', () => {
  const content = JSON.stringify({ agent: { a: {} }, plugin: ['x'] });
  assert.strictEqual(transformInstallContent({ contentTransform: OPENCODE_HOME_CONFIG_TRANSFORM }, content), projectOpenCodeHomeConfig(content));
});

test('package closure follows production dependencies and skips missing packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-closure-'));
  try {
    const write = (name, deps) => {
      const dir = path.join(root, 'node_modules', ...name.split('/'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, dependencies: deps }));
    };
    write('alpha', { '@scope/beta': '1' });
    write('@scope/beta', { gamma: '1', missing: '1' });
    write('gamma', {});
    assert.deepStrictEqual(opencodeHome.resolvePackageClosure(root, ['alpha']), ['@scope/beta', 'alpha', 'gamma']);
    assert.deepStrictEqual(opencodeHome.resolvePackageClosure(root, ['absent']), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('home installs copy only config-root children, entrypoint last', () => {
  assert.deepStrictEqual([...opencodeHome.CONFIG_ROOT_CHILDREN], ['ecc', 'commands', 'prompts', 'instructions', 'plugins']);
  assert.deepStrictEqual([...opencodeHome.HOOK_RUNTIME_PACKAGES], ['js-yaml', 'ajv']);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
