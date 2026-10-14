'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const runner = path.join(repoRoot, 'scripts/hooks/run-with-flags.js');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed += 1; }
  catch (error) { console.log(`  FAIL ${name}: ${error.message}`); failed += 1; }
}

function capture(phase, input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-observe-redaction-'));
  try {
    const data = path.join(root, 'data');
    const result = spawnSync(process.execPath, [runner, `${phase}:observe`,
      'scripts/hooks/observe-runner.js', 'standard,strict'], {
      input: JSON.stringify({ cwd: root, session_id: 'redaction-fixture', ...input }),
      cwd: root, encoding: 'utf8', timeout: 12000,
      env: { ...process.env, HOME: root, USERPROFILE: root,
        CLV2_HOMUNCULUS_DIR: data, CLAUDE_CODE_ENTRYPOINT: 'cli',
        ECC_HOOK_PROFILE: 'standard', ECC_SKIP_OBSERVE: '0',
        ECC_DISABLED_HOOKS: '', ECC_OBSERVER_ENABLED: 'false' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /runner failed|timed out/i);
    const records = fs.readFileSync(path.join(data, 'observations.jsonl'), 'utf8');
    assert.equal(records.trim().split('\n').length, 1);
    assert.equal(JSON.parse(records).event, phase === 'pre' ? 'tool_start' : 'tool_complete');
    return records;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('=== Actual registered observation secret redaction ===');
if (process.platform === 'win32') {
  console.log('Skipping shell fixtures: native Windows runner requires platform CI.');
} else if (spawnSync('python3', ['--version']).status !== 0) {
  console.log('  FAIL python3 is required for observation redaction tests');
  failed += 1;
} else {
  // Synthetic canary data proves that captured credential-shaped text is masked.
  const canary = 'CANARY_TOKEN_abcdefghijk';
  const pemCanary = 'MIIEcanaryPEMbodyAAAA';
  for (const [label, content, secret = canary] of [
    ['double-quoted source', 'const apiKey = "CANARY_TOKEN_abcdefghijk";'],
    ['single-quoted source', "const password = 'CANARY_TOKEN_abcdefghijk';"],
    ['JSON credential', '{"token":"CANARY_TOKEN_abcdefghijk"}'],
    ['nested escaped source', 'const auth = \\"CANARY_TOKEN_abcdefghijk\\";'],
    ['compound env var name', 'AWS_SECRET_ACCESS_KEY=CANARY/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'CANARY/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['lowercase compound name', 'aws_secret_access_key = CANARY/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'CANARY/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['DSN password', 'DATABASE_URL=postgres://app:CANARYdsnPassw0rd@db.internal:5432/app',
      'CANARYdsnPassw0rd'],
    ['PEM private key block', `-----BEGIN RSA ${'PRIVATE'} KEY-----\n${pemCanary}\n-----END RSA PRIVATE KEY-----`,
      pemCanary],
    ['truncated PEM private key block', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\n${pemCanary}`, pemCanary],
    ['GitHub classic token', `GH_PAT=${'ghp_'}CANARY${'0'.repeat(30)}`, `CANARY${'0'.repeat(30)}`],
    ['GitHub fine-grained token', `use ${'github_pat_'}CANARY_${'1'.repeat(40)}`, `CANARY_${'1'.repeat(40)}`],
    ['AWS access key id', `key id ${'AKIA'}CANARY0EXAMPLE00`, 'CANARY0EXAMPLE00']
  ]) {
    test(`redacts ${label} before persisting tool input`, () => {
      const records = capture('pre', { tool_name: 'Write',
        tool_input: { file_path: '/tmp/example.js', content } });
      assert.ok(!records.includes(secret), 'seeded credential persisted');
      assert.ok(records.includes('[REDACTED]'));
    });
    test(`redacts ${label} before persisting structured tool output`, () => {
      const records = capture('post', { tool_name: 'Read',
        tool_input: { file_path: '/tmp/example.js' }, tool_response: { content } });
      assert.ok(!records.includes(secret), 'seeded credential persisted');
      assert.ok(records.includes('[REDACTED]'));
    });
  }

  // Ordinary code, URLs without credentials and SSH remotes stay readable.
  const benign = [
    'const tokenizer = new Tokenizer(config);',
    'max_tokens_per_request = 4096',
    'token_count = countTokens(text)',
    'password_hash = hashlib.sha256(pw)',
    'fetch(http://localhost:8080/api/v1)',
    'git clone git@github.com:org/repo.git',
    'https://user@example.com/path'
  ];
  test('keeps ordinary code and credential-free URLs unredacted', () => {
    const records = capture('post', { tool_name: 'Read',
      tool_input: { file_path: '/tmp/example.js' }, tool_response: { content: benign.join('\n') } });
    for (const line of benign) assert.ok(records.includes(line), `benign text altered: ${line}`);
    assert.ok(!records.includes('[REDACTED]'));
  });
}
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
