'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { createManifestInstallPlan, applyInstallPlan } = require('../../scripts/lib/install-executor');
const { withHookConsent } = require('../../scripts/lib/install/hook-consent');

const repo = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(repo, 'tests', '.opencode-modular-runtime-'));
const home = path.join(fixture, 'home');
const project = path.join(fixture, 'project');
fs.mkdirSync(home);
fs.mkdirSync(project);
let failed = 0;
try {
  const build = spawnSync(process.execPath, [path.join(repo, 'scripts/build-opencode.js')], { encoding: 'utf8' });
  assert.strictEqual(build.status, 0, build.stderr || build.stdout);
  const plan = withHookConsent(createManifestInstallPlan({
    sourceRoot: repo, homeDir: home, projectRoot: project, env: {},
    target: 'opencode', moduleIds: ['platform-configs', 'hooks-runtime'],
  }), 'enabled');
  applyInstallPlan(plan);
  assert.ok(!fs.existsSync(path.join(plan.targetRoot, 'skills')), 'Optional skills must stay absent');
  const marker = path.join(plan.targetRoot, 'scripts/package.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).type, 'commonjs');
  assert.ok(plan.statePreview.operations.some(operation => operation.destinationPath === marker));
  const input = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.argv[1];
    const names = fs.readdirSync(path.join(root, 'plugins'));
    assert.deepEqual(names, ['ecc.ts'], 'Local discovery must find exactly one ECC plugin file');
    const plugin = (await import(pathToFileURL(path.join(root, 'plugins', 'ecc.ts')).href)).default;
    assert.equal(plugin.id, 'ecc');
    const hooks = { tool: {}, shell: {} };
    const ctx = {
      location: { directory: process.cwd() },
      tool: { transform: async () => {}, hook: async (n, cb) => { hooks.tool[n] = cb; } },
      permission: { hook: async () => {} },
      shell: { hook: async (n, cb) => { hooks.shell[n] = cb; } },
      session: { hook: async () => {} },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    };
    const dispose = await plugin.setup(ctx);
    assert.equal(typeof hooks.tool['execute.after'], 'function', 'The installed hook runtime enables the bridge');
    await hooks.tool['execute.after']({ tool: 'skill', sessionID: 'ses_offline', id: 'call_1',
      input: { id: 'code-review', arguments: 'private prompt sentinel' }, status: 'completed', result: { content: [] } });
    const runsPath = path.join(process.env.ECC_AGENT_DATA_HOME, 'state/skill-runs.jsonl');
    for (let i = 0; i < 150 && !fs.existsSync(runsPath); i++) await new Promise(r => setTimeout(r, 100));
    const runs = fs.readFileSync(runsPath, 'utf8');
    assert.equal(runs.trim().split('\\n').length, 1);
    assert.equal(JSON.parse(runs).skill_id, 'code-review');
    assert.ok(!runs.includes('private prompt sentinel'));
    const shell = { command: 'ls', cwd: process.cwd(), env: {} };
    await hooks.shell['create.before'](shell);
    assert.equal(shell.env.CLAUDE_PLUGIN_ROOT, fs.realpathSync(root));
    await dispose();
    console.log('PASS: one installed plugin, one private skill record, canonical root export');
  `;
  const result = spawnSync(process.execPath, ['--loader',
    pathToFileURL(path.join(repo, 'tests/fixtures/opencode-ts-loader.mjs')).href,
    '--input-type=module', '-e', input, plan.targetRoot], {
    cwd: project, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ECC_AGENT_DATA_HOME: path.join(home, '.claude'),
      XDG_CONFIG_HOME: path.join(home, '.config'), OPENCODE_CONFIG_DIR: plan.targetRoot,
      CLAUDE_PLUGIN_ROOT: '', CLAUDE_CODE_PACKAGE_MANAGER: 'bun', ECC_HOOK_PROFILE: 'standard', ECC_DISABLED_HOOKS: '',
      ECC_OPENCODE_INSTRUCTIONS: '0' },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  console.log(result.stdout.trim());
  const standalone = spawnSync(process.execPath,
    [path.join(plan.targetRoot, 'scripts/hooks/post-bash-command-log.js'), 'audit'], {
      cwd: project, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo standalone-offline' } }),
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    });
  assert.strictEqual(standalone.status, 0, standalone.stderr);
  assert.match(fs.readFileSync(path.join(home, '.claude/bash-commands.log'), 'utf8'), /standalone-offline/);
} catch (error) {
  failed = 1;
  console.error(error.stack);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(`Passed: ${1 - failed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed;
