'use strict';

// Exercise the public stdin hook with isolated user data and an unrelated cwd.
// These fixtures prove local controls, not native host consent or authentication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const hook = path.join(repo, 'skills/continuous-learning-v2/hooks/observe.sh');
let passed = 0;
let failed = 0;

function test(name, fn) {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-scope-safety-'));
  try {
    fn(root);
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}: ${error.message}`);
    failed += 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fixture(root) {
  const home = path.join(root, 'home');
  const data = path.join(home, '.local/share/ecc-homunculus');
  const decoy = path.join(root, 'decoy');
  const explicit = path.join(root, 'explicit');
  const subdir = path.join(explicit, 'src');
  fs.mkdirSync(subdir, { recursive: true });
  fs.mkdirSync(decoy);
  for (const cwd of [decoy, explicit]) {
    assert.equal(spawnSync('git', ['init'], { cwd }).status, 0);
  }
  const files = {
    'observations.jsonl': '{"user":"existing-global"}\n',
    'config.json': '{"observer":{"enabled":false}}\n',
    'projects.json': '{"user-owned":{"name":"preserved"}}\n',
    'instincts/personal/user.md': 'existing global instinct\n',
    'projects/user-owned/observations.jsonl': '{"user":"existing-scoped"}\n',
    'projects/user-owned/instincts/personal/user.md': 'existing scoped instinct\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(data, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  // Allow only runtime environment here, never ambient credentials or scope.
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    CLAUDE_CODE_ENTRYPOINT: 'cli', ECC_HOOK_PROFILE: 'standard',
    ECC_SKIP_OBSERVE: '0', CLV2_CONFIG: path.join(data, 'config.json') };
  return { data, decoy, explicit, subdir, files, env };
}

function run(f, payload, extraEnv = {}, phase = 'post', registered = false) {
  const command = registered ? process.execPath : 'bash';
  const args = registered
    ? [path.join(repo, 'scripts/hooks/run-with-flags.js'), `${phase}:observe`,
      'scripts/hooks/observe-runner.js', 'standard,strict']
    : [hook, phase];
  const result = spawnSync(command, args, { cwd: f.decoy,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 20000, env: { ...f.env, ...extraEnv } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /runner failed|timed out/i);
}

function preserved(f, { globalAppend = false, registryUpdate = false } = {}) {
  for (const [relative, content] of Object.entries(f.files)) {
    const actual = fs.readFileSync(path.join(f.data, relative), 'utf8');
    if (relative === 'observations.jsonl' && globalAppend) {
      assert.ok(actual.startsWith(content), 'existing global observations changed');
    } else if (relative === 'projects.json' && registryUpdate) {
      assert.deepEqual(JSON.parse(actual)['user-owned'], JSON.parse(content)['user-owned']);
    } else assert.equal(actual, content, `user file changed: ${relative}`);
  }
}

// Assemble the synthetic redaction input at runtime; it is never a credential.
const REDACTION_CANARY = ['CANARY', 'abcdefghijk'].join('_');
const payload = { tool_name: 'Read', session_id: 'scope-safety',
  tool_response: { content: `password = "${REDACTION_CANARY}"` } };

for (const cwd of [undefined, '', null, '/no-such-ecc-scope-directory']) {
  test(`unusable cwd ${JSON.stringify(cwd)} appends globally and preserves scoped user files`, root => {
    const f = fixture(root);
    run(f, { ...payload, ...(cwd === undefined ? {} : { cwd }) });
    preserved(f, { globalAppend: true });
    const rows = fs.readFileSync(path.join(f.data, 'observations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 2);
    const record = JSON.parse(rows[1]);
    assert.equal(record.project_id, 'global');
    assert.ok(record.output.includes('[REDACTED]'));
    assert.ok(!record.output.includes(REDACTION_CANARY));
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'projects')), ['user-owned']);
    assert.ok(!fs.existsSync(path.join(f.data, '.observer.pid')));
  });
}

test('explicit payload subdirectory wins over inherited scope and redacts pre input', root => {
  const f = fixture(root);
  run(f, { ...payload, cwd: f.subdir,
    tool_input: { content: `token = "${REDACTION_CANARY}"` } },
  { CLAUDE_PROJECT_DIR: f.decoy }, 'pre');
  preserved(f, { registryUpdate: true });
  const registry = JSON.parse(fs.readFileSync(path.join(f.data, 'projects.json')));
  const entries = Object.values(registry).filter(entry => entry.root);
  assert.equal(entries.length, 1);
  assert.equal(fs.realpathSync(entries[0].root), fs.realpathSync(f.explicit));
  const stored = fs.readFileSync(path.join(f.data, 'projects', entries[0].id, 'observations.jsonl'), 'utf8');
  assert.equal(JSON.parse(stored).event, 'tool_start');
  assert.ok(stored.includes('[REDACTED]'));
  assert.ok(!stored.includes(REDACTION_CANARY));
});

test('malformed stdin is redacted in global fallback without registering decoy', root => {
  const f = fixture(root);
  run(f, `invalid JSON token=${REDACTION_CANARY}`);
  preserved(f, { globalAppend: true });
  const rows = fs.readFileSync(path.join(f.data, 'observations.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[1]).event, 'parse_error');
  assert.ok(rows[1].includes('[REDACTED]'));
  assert.ok(!rows[1].includes(REDACTION_CANARY));
  assert.deepEqual(fs.readdirSync(path.join(f.data, 'projects')), ['user-owned']);
});

test('missing payload cwd keeps an explicit git project and preserves the global bucket', root => {
  const f = fixture(root);
  run(f, payload, { CLAUDE_PROJECT_DIR: f.subdir });
  preserved(f, { registryUpdate: true });
  const registry = JSON.parse(fs.readFileSync(path.join(f.data, 'projects.json')));
  const entries = Object.values(registry).filter(entry => entry.root);
  assert.equal(entries.length, 1);
  assert.equal(fs.realpathSync(entries[0].root), fs.realpathSync(f.explicit));
  const stored = fs.readFileSync(path.join(f.data, 'projects', entries[0].id, 'observations.jsonl'), 'utf8');
  const record = JSON.parse(stored);
  assert.equal(record.project_id, entries[0].id);
  assert.equal(record.project_name, 'explicit');
});

test('custom config disabled marker stops capture without touching either bucket', root => {
  const f = fixture(root);
  const configDir = path.join(root, 'custom-config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'config.json'), f.files['config.json']);
  fs.writeFileSync(path.join(configDir, 'disabled'), 'user disabled capture\n');
  run(f, { ...payload, cwd: f.subdir }, { CLV2_CONFIG: path.join(configDir, 'config.json') });
  preserved(f);
  assert.deepEqual(fs.readdirSync(path.join(f.data, 'projects')), ['user-owned']);
  assert.ok(!fs.existsSync(path.join(f.data, '.observer-last-activity')));
});

test('valid explicit project clears inherited global-scope marker', root => {
  const f = fixture(root);
  run(f, payload, { CLAUDE_PROJECT_DIR: f.subdir, CLV2_NO_PROJECT: '1' });
  preserved(f, { registryUpdate: true });
  const entries = Object.values(JSON.parse(fs.readFileSync(path.join(f.data, 'projects.json'))))
    .filter(entry => entry.root);
  assert.equal(entries.length, 1);
  assert.equal(fs.realpathSync(entries[0].root), fs.realpathSync(f.explicit));
  const stored = fs.readFileSync(path.join(f.data, 'projects', entries[0].id, 'observations.jsonl'), 'utf8');
  assert.equal(JSON.parse(stored).project_id, entries[0].id);
});

// Root bypasses mode bits, so this permission fixture requires an ordinary user.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.log('SKIP: inaccessible explicit directory fixture requires an ordinary user');
} else test('inaccessible explicit directory selects global instead of inherited git scope', root => {
  const f = fixture(root);
  const inaccessible = path.join(root, 'inaccessible');
  fs.mkdirSync(inaccessible);
  fs.chmodSync(inaccessible, 0);
  try {
    const probe = spawnSync('bash', ['-c', 'cd "$CLAUDE_PROJECT_DIR"'], {
      env: { ...f.env, CLAUDE_PROJECT_DIR: inaccessible }, encoding: 'utf8' });
    assert.notEqual(probe.status, 0, 'fixture must actually prevent directory entry');
    run(f, payload, { CLAUDE_PROJECT_DIR: inaccessible });
    preserved(f, { globalAppend: true });
    const rows = fs.readFileSync(path.join(f.data, 'observations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 2);
    assert.equal(JSON.parse(rows[1]).project_id, 'global');
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'projects')), ['user-owned']);
  } finally {
    fs.chmodSync(inaccessible, 0o700);
  }
});

for (const [label, extraEnv, input, disabled, registered] of [
  ['empty stdin', {}, '', false, false],
  ['capture skip', { ECC_SKIP_OBSERVE: '1' }, payload, false, false],
  ['minimal profile', { ECC_HOOK_PROFILE: 'minimal' }, payload, false, false],
  ['unknown entrypoint', { CLAUDE_CODE_ENTRYPOINT: 'automated-bot' }, payload, false, false],
  ['subagent', {}, { ...payload, agent_id: 'fixture-agent' }, false, false],
  ['excluded path', {}, { ...payload, cwd: '/fixture/observer-sessions' }, false, false],
  ['data disabled marker', {}, payload, true, false],
  ['registered hook disabled', { ECC_DISABLED_HOOKS: 'post:observe' }, payload, false, true],
]) {
  test(`${label} exits without changing user files or registering inherited cwd`, root => {
    const f = fixture(root);
    if (disabled) fs.writeFileSync(path.join(f.data, 'disabled'), 'user disabled capture\n');
    let cwd = f.subdir;
    if (label === 'excluded path') {
      cwd = path.join(f.explicit, 'observer-sessions');
      fs.mkdirSync(cwd);
    }
    // A valid project exposes guards accidentally moved below registration.
    const event = typeof input === 'string' ? input : { ...input, cwd };
    run(f, event, extraEnv, 'post', registered);
    preserved(f);
    assert.deepEqual(fs.readdirSync(path.join(f.data, 'projects')), ['user-owned']);
    assert.ok(!fs.existsSync(path.join(f.data, '.observer-last-activity')));
  });
}

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
