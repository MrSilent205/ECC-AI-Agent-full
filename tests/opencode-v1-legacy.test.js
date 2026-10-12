/**
 * Tests for the OpenCode v1 entry (`server`) of the ECC plugin.
 *
 * The v1 path shares the hook bridge with v2, so these run against the real
 * hooks/hooks.json scripts in this repository with an isolated HOME.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..');

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      return { passed: 1, failed: 0 };
    })
    .catch(error => {
      console.log(`  ✗ ${name}`);
      console.error(`    ${error.stack || error.message}`);
      return { passed: 0, failed: 1 };
    });
}

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('condition not met in time');
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function main() {
  console.log('\n=== Testing OpenCode v1 legacy entry ===\n');
  const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-opencode.js')], { cwd: repoRoot, encoding: 'utf8' });
  assert.strictEqual(build.status, 0, build.stderr || build.stdout);
  const plugin = (await import(pathToFileURL(path.join(repoRoot, '.opencode', 'dist', 'plugins', 'ecc.js')).href)).default;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc-v1-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc-v1-project-'));
  fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');
  fs.mkdirSync(path.join(project, 'tsconfig.json'));
  const isolated = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ECC_AGENT_DATA_HOME: path.join(home, '.claude'),
    CLAUDE_PLUGIN_ROOT: undefined,
    ECC_HOOK_PROFILE: 'standard',
    ECC_DISABLED_HOOKS: '',
    ECC_OPENCODE_INSTRUCTIONS: '0'
  };
  const logs = [];
  const input = {
    client: {
      app: {
        log: ({ body }) => {
          logs.push(body);
          return Promise.resolve();
        }
      }
    },
    directory: project,
    worktree: project
  };
  const hooks = await withEnv(isolated, () => plugin.server(input));

  const tests = [
    [
      'server returns the v1 hook surface',
      () => {
        for (const key of [
          'tool.execute.before',
          'tool.execute.after',
          'event',
          'shell.env',
          'experimental.session.compacting',
          'permission.ask',
          'experimental.chat.system.transform',
          'chat.message'
        ]) {
          assert.strictEqual(typeof hooks[key], 'function', key);
        }
      }
    ],

    [
      'tool.execute.before throws to block through the shared bash dispatcher',
      () =>
        withEnv(isolated, async () => {
          const command = ['git', 'commit', '--allow-empty', '--no-' + 'verify', '-m', 'x'].join(' ');
          await assert.rejects(() => hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_v1', callID: 'c1' }, { args: { command } }), /\[ECC pre:bash:dispatcher\].*no-verify/);
          await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_v1', callID: 'c2' }, { args: { command: 'echo ok' } });
        })
    ],

    [
      'skill telemetry records a run through the PostToolUse dispatcher',
      () =>
        withEnv(isolated, async () => {
          await hooks['tool.execute.after']({ tool: 'skill', sessionID: 'ses_v1', callID: 'c3', args: { name: 'code-review', arguments: 'private prompt sentinel' } }, { output: '' });
          const runs = path.join(home, '.claude', 'state', 'skill-runs.jsonl');
          await waitFor(() => fs.existsSync(runs));
          const lines = fs.readFileSync(runs, 'utf8').trim().split('\n');
          assert.strictEqual(JSON.parse(lines[0]).skill_id, 'code-review');
          assert.ok(!fs.readFileSync(runs, 'utf8').includes('private prompt sentinel'));
        })
    ],

    [
      'shell.env exports the ECC root and detects real project files only',
      async () => {
        const output = { env: {} };
        await withEnv(isolated, () => hooks['shell.env']({ cwd: project }, output));
        assert.strictEqual(output.env.ECC_PLUGIN, 'true');
        assert.strictEqual(output.env.PACKAGE_MANAGER, 'pnpm');
        assert.strictEqual(output.env.DETECTED_LANGUAGES, undefined, 'a directory named tsconfig.json is not a marker');
        assert.strictEqual(fs.realpathSync(output.env.CLAUDE_PLUGIN_ROOT), fs.realpathSync(repoRoot));
        const preset = { env: { CLAUDE_PLUGIN_ROOT: '/other' } };
        await withEnv(isolated, () => hooks['shell.env']({ cwd: project }, preset));
        assert.strictEqual(preset.env.CLAUDE_PLUGIN_ROOT, '/other');
      }
    ],

    [
      'compacting appends ECC guidance without replacing the host prompt',
      async () => {
        const withContext = { context: ['host'] };
        await withEnv(isolated, () => hooks['experimental.session.compacting']({ sessionID: 'ses_v1' }, withContext));
        assert.strictEqual(withContext.context[0], 'host');
        assert.match(withContext.context[1], /ECC context/);
        const withPrompt = { context: [], prompt: '' };
        await withEnv(isolated, () => hooks['experimental.session.compacting']({ sessionID: 'ses_v1' }, withPrompt));
        assert.match(withPrompt.prompt, /ECC context/);
        assert.deepStrictEqual(withPrompt.context, []);
      }
    ],

    [
      'permission.ask auto-approves reads, formatters and tests only',
      async () => {
        assert.deepStrictEqual(await hooks['permission.ask']({ tool: 'read' }), { approved: true });
        assert.deepStrictEqual(await hooks['permission.ask']({ tool: 'bash', args: { command: 'npx prettier --write a.ts' } }), { approved: true });
        assert.deepStrictEqual(await hooks['permission.ask']({ tool: 'bash', args: 'npm test' }), { approved: true });
        assert.deepStrictEqual(await hooks['permission.ask']({ tool: 'bash', args: { command: 'rm -rf /' } }), { approved: undefined });
      }
    ]
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn);
    passed += result.passed;
    failed += result.failed;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
