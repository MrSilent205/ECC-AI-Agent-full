/**
 * Regression for observe.sh when the hook payload has no usable cwd.
 * Issue #2746, defect 1.
 *
 * The hook must not let detect-project.sh priority 2 (`git rev-parse`
 * against the inherited working directory) choose a project. A valid
 * inherited CLAUDE_PROJECT_DIR stays an explicit override, including a
 * non-git directory (#2469 / #2488). Anything else is forced into the
 * global bucket via CLV2_NO_PROJECT.
 *
 * Run with: node tests/hooks/observe-missing-cwd.test.js
 */

if (process.platform === 'win32') {
  console.log('Skipping bash-dependent observe tests on Windows');
  console.log('Passed: 0');
  console.log('Failed: 0');
  process.exit(0);
}

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
let failed = 0;

const repoRoot = path.resolve(__dirname, '..', '..');
const observeShPath = path.join(
  repoRoot,
  'skills',
  'continuous-learning-v2',
  'hooks',
  'observe.sh'
);

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`FAIL: ${name}`);
    console.error(`  ${error.message}`);
    failed += 1;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-observe-missing-cwd-'));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(`[cleanupDir] failed to remove ${dir}: ${error.message}`);
  }
}

function normalizeComparablePath(filePath) {
  if (!filePath) {
    return filePath;
  }
  const normalized = fs.realpathSync(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function gitInit(dir) {
  const initResult = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(initResult.status, 0, initResult.stderr || 'git init failed');
}

function homunculusDir(homeDir) {
  return path.join(homeDir, '.local', 'share', 'ecc-homunculus');
}

// `cwd` omitted when cwdField is the symbol OMIT.
const OMIT = Symbol('omit-cwd');

function hookPayload(cwdField) {
  const payload = {
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
    tool_response: 'ok',
    session_id: 'session-missing-cwd',
  };
  if (cwdField !== OMIT) {
    payload.cwd = cwdField;
  }
  return payload;
}

function runObserve({ homeDir, processCwd, cwdField, claudeProjectDir }) {
  const env = { ...process.env };
  // The hook must not see host credentials, and parent project-detection
  // knobs must not mask the payload-cwd fallback under test.
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CLV2_NO_PROJECT',
    'CLV2_HOMUNCULUS_DIR',
    'CLV2_CONFIG',
    'XDG_DATA_HOME',
    'GIT_DIR',
    'GIT_WORK_TREE',
  ]) {
    delete env[key];
  }
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  env.ECC_HOOK_PROFILE = 'standard';
  env.ECC_SKIP_OBSERVE = '0';
  if (claudeProjectDir === undefined) {
    env.CLAUDE_PROJECT_DIR = '';
  } else {
    env.CLAUDE_PROJECT_DIR = claudeProjectDir;
  }

  return spawnSync('bash', [observeShPath, 'post'], {
    cwd: processCwd,
    encoding: 'utf8',
    input: JSON.stringify(hookPayload(cwdField)),
    env,
    timeout: 20000,
  });
}

function readObservation(filePath) {
  assert.ok(fs.existsSync(filePath), `expected an observation at ${filePath}`);
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, `expected exactly one observation, got ${lines.length}`);
  return JSON.parse(lines[0]);
}

function assertGlobalNotInherited(homeDir) {
  const root = homunculusDir(homeDir);
  const projectsDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'projects.json');
  const observationsPath = path.join(root, 'observations.jsonl');

  assert.ok(
    !fs.existsSync(registryPath),
    'unusable payload cwd must not register the hook process working directory'
  );
  assert.ok(
    !fs.existsSync(projectsDir) || fs.readdirSync(projectsDir).length === 0,
    'unusable payload cwd must not create a project directory from the inherited working directory'
  );

  const observation = readObservation(observationsPath);
  assert.strictEqual(observation.project_id, 'global', 'observation must be stored in the global bucket');
  assert.strictEqual(observation.project_name, 'global');
  assert.notStrictEqual(
    observation.project_name,
    'decoy-repo',
    'observation must not adopt the inherited git checkout name'
  );
}

function assertProjectScope(homeDir, projectDir, projectName) {
  const root = homunculusDir(homeDir);
  const projectsDir = path.join(root, 'projects');
  assert.ok(fs.existsSync(projectsDir), 'a valid CLAUDE_PROJECT_DIR should create a project directory');
  const projectIds = fs.readdirSync(projectsDir);
  assert.strictEqual(projectIds.length, 1, `expected one project, got ${projectIds.join(',')}`);

  const storedDir = path.join(projectsDir, projectIds[0]);
  const metadata = JSON.parse(fs.readFileSync(path.join(storedDir, 'project.json'), 'utf8'));
  assert.strictEqual(metadata.name, projectName);
  assert.strictEqual(
    normalizeComparablePath(metadata.root),
    normalizeComparablePath(projectDir),
    'project root must be the inherited CLAUDE_PROJECT_DIR, not the hook working directory'
  );
  assert.notStrictEqual(metadata.name, 'decoy-repo');

  const observation = readObservation(path.join(storedDir, 'observations.jsonl'));
  assert.strictEqual(observation.project_name, projectName);
  assert.notStrictEqual(observation.project_id, 'global');
  assert.ok(observation.project_id && observation.project_id.length > 0);

  const globalObservations = path.join(root, 'observations.jsonl');
  assert.ok(
    !fs.existsSync(globalObservations),
    'a valid CLAUDE_PROJECT_DIR must not also write the global observations file'
  );
}

function withDecoyRepo(fn) {
  const testRoot = createTempDir();
  try {
    const homeDir = path.join(testRoot, 'home');
    const decoyRepo = path.join(testRoot, 'decoy-repo');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(decoyRepo, { recursive: true });
    gitInit(decoyRepo);
    fn({ testRoot, homeDir, decoyRepo });
  } finally {
    cleanupDir(testRoot);
  }
}

console.log('\n=== Observe.sh missing/invalid payload cwd (issue #2746) ===\n');

test('omitted payload cwd does not adopt the inherited git working directory', () => {
  withDecoyRepo(({ homeDir, decoyRepo }) => {
    const result = runObserve({ homeDir, processCwd: decoyRepo, cwdField: OMIT });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'observe.sh failed');
    assertGlobalNotInherited(homeDir);
  });
});

test('empty payload cwd does not adopt the inherited git working directory', () => {
  withDecoyRepo(({ homeDir, decoyRepo }) => {
    const result = runObserve({ homeDir, processCwd: decoyRepo, cwdField: '' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'observe.sh failed');
    assertGlobalNotInherited(homeDir);
  });
});

test('nonexistent payload cwd does not adopt the inherited git working directory', () => {
  withDecoyRepo(({ testRoot, homeDir, decoyRepo }) => {
    const missing = path.join(testRoot, 'no-such-directory');
    const result = runObserve({ homeDir, processCwd: decoyRepo, cwdField: missing });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'observe.sh failed');
    assertGlobalNotInherited(homeDir);
  });
});

test('invalid inherited CLAUDE_PROJECT_DIR still forces global instead of the inherited git checkout', () => {
  withDecoyRepo(({ testRoot, homeDir, decoyRepo }) => {
    const missingProject = path.join(testRoot, 'missing-claude-project');
    const result = runObserve({
      homeDir,
      processCwd: decoyRepo,
      cwdField: OMIT,
      claudeProjectDir: missingProject,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'observe.sh failed');
    assertGlobalNotInherited(homeDir);
  });
});

test('omitted payload cwd keeps a valid non-git CLAUDE_PROJECT_DIR', () => {
  withDecoyRepo(({ testRoot, homeDir, decoyRepo }) => {
    const plainProject = path.join(testRoot, 'plain-project');
    fs.mkdirSync(plainProject, { recursive: true });
    assert.ok(!fs.existsSync(path.join(plainProject, '.git')), 'guard: CLAUDE_PROJECT_DIR must not be a git repo');

    const result = runObserve({
      homeDir,
      processCwd: decoyRepo,
      cwdField: OMIT,
      claudeProjectDir: plainProject,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'observe.sh failed');
    assertProjectScope(homeDir, plainProject, 'plain-project');
  });
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
