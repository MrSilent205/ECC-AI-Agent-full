const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  getHomunculusDir,
  normalizeRemoteUrl,
  computeProjectId,
  resolveProjectContext,
} = require('../../scripts/lib/observer-sessions');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    failed += 1;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-observer-sessions-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function initRepo(repoDir, remoteUrl) {
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: repoDir, stdio: 'ignore' });
}

console.log('\n=== observer-sessions tests ===\n');

test('getHomunculusDir prefers absolute CLV2_HOMUNCULUS_DIR', () => {
  const root = createTempDir();
  try {
    const override = path.join(root, 'custom-store');
    withEnv({ CLV2_HOMUNCULUS_DIR: override, XDG_DATA_HOME: path.join(root, 'xdg') }, () => {
      assert.strictEqual(getHomunculusDir(), override);
    });
  } finally {
    cleanup(root);
  }
});

test('getHomunculusDir ignores relative overrides and uses XDG_DATA_HOME', () => {
  const root = createTempDir();
  try {
    const xdg = path.join(root, 'xdg');
    withEnv({ CLV2_HOMUNCULUS_DIR: 'relative-store', XDG_DATA_HOME: xdg }, () => {
      assert.strictEqual(getHomunculusDir(), path.join(xdg, 'ecc-homunculus'));
    });
  } finally {
    cleanup(root);
  }
});

test('normalizeRemoteUrl collapses common network remote variants', () => {
  const expected = 'github.com/owner/repo';
  assert.strictEqual(normalizeRemoteUrl('git@github.com:Owner/Repo.git'), expected);
  assert.strictEqual(normalizeRemoteUrl('https://github.com/owner/repo.git'), expected);
  assert.strictEqual(normalizeRemoteUrl('ssh://git@github.com/Owner/Repo.git'), expected);
  assert.strictEqual(normalizeRemoteUrl('https://token@github.com/owner/repo.git'), expected);
});

test('normalizeRemoteUrl preserves local path case', () => {
  assert.strictEqual(normalizeRemoteUrl('/tmp/Repos/MyProject'), '/tmp/Repos/MyProject');
  assert.strictEqual(normalizeRemoteUrl('file:///tmp/Repos/MyProject.git'), '/tmp/Repos/MyProject');
});

test('resolveProjectContext gives SSH and HTTPS clones the same project id', () => {
  const root = createTempDir();
  try {
    const storage = path.join(root, 'store');
    const sshRepo = path.join(root, 'ssh-clone');
    const httpsRepo = path.join(root, 'https-clone');
    initRepo(sshRepo, 'git@github.com:Owner/Repo.git');
    initRepo(httpsRepo, 'https://github.com/owner/repo.git');

    withEnv({
      CLV2_HOMUNCULUS_DIR: storage,
      XDG_DATA_HOME: undefined,
      CLAUDE_PROJECT_DIR: undefined,
    }, () => {
      const sshContext = resolveProjectContext(sshRepo);
      const httpsContext = resolveProjectContext(httpsRepo);
      assert.strictEqual(sshContext.projectId, httpsContext.projectId);
      assert.strictEqual(sshContext.projectDir, httpsContext.projectDir);
    });
  } finally {
    cleanup(root);
  }
});

test('resolveProjectContext prefers computed remote-hash id over older path-hash registry entry', () => {
  const root = createTempDir();
  try {
    const storage = path.join(root, 'store');
    const repo = path.join(root, 'my-repo');
    initRepo(repo, 'https://github.com/owner/my-repo.git');

    const expectedRemoteId = computeProjectId(repo);
    const stalePathHashId = 'oldpathhash12';

    // Simulate projects.json having an older entry created before remote was added
    const registryPath = path.join(storage, 'projects.json');
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        [stalePathHashId]: {
          id: stalePathHashId,
          name: 'my-repo',
          root: repo,
          remote: '',
        },
        [expectedRemoteId]: {
          id: expectedRemoteId,
          name: 'my-repo',
          root: repo,
          remote: 'https://github.com/owner/my-repo.git',
        },
      }, null, 2)
    );

    let stderrOutput = '';
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };

    try {
      withEnv({
        CLV2_HOMUNCULUS_DIR: storage,
        XDG_DATA_HOME: undefined,
        CLAUDE_PROJECT_DIR: undefined,
      }, () => {
        const context = resolveProjectContext(repo);
        assert.strictEqual(context.projectId, expectedRemoteId);
        assert.strictEqual(context.projectDir, path.join(storage, 'projects', expectedRemoteId));
        assert.ok(
          stderrOutput.includes(`Multiple registry entries found for ${repo}`),
          'Expected warning on duplicate registry entries'
        );
        assert.ok(
          stderrOutput.includes(`instinct-cli.py projects merge ${stalePathHashId} ${expectedRemoteId}`),
          'Expected merge command guidance in warning'
        );
      });
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  } finally {
    cleanup(root);
  }
});

test('resolveProjectContext uses computed remote-hash id even if registry only contains pre-remote entry', () => {
  const root = createTempDir();
  try {
    const storage = path.join(root, 'store');
    const repo = path.join(root, 'my-repo');
    initRepo(repo, 'https://github.com/owner/my-repo.git');

    const expectedRemoteId = computeProjectId(repo);
    const stalePathHashId = 'oldpathhash12';

    const registryPath = path.join(storage, 'projects.json');
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        [stalePathHashId]: {
          id: stalePathHashId,
          name: 'my-repo',
          root: repo,
          remote: '',
        },
      }, null, 2)
    );

    withEnv({
      CLV2_HOMUNCULUS_DIR: storage,
      XDG_DATA_HOME: undefined,
      CLAUDE_PROJECT_DIR: undefined,
    }, () => {
      const context = resolveProjectContext(repo);
      assert.strictEqual(context.projectId, expectedRemoteId);
      assert.strictEqual(context.projectDir, path.join(storage, 'projects', expectedRemoteId));
    });
  } finally {
    cleanup(root);
  }
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
