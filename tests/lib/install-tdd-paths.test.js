'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createManifestInstallPlan, applyInstallPlan } = require('../../scripts/lib/install-executor');
const { repairInstalledStates, uninstallInstalledStates } = require('../../scripts/lib/install-lifecycle');

function detectorBlock(skill) {
  const step = skill.split('### Step 0: Detect the Test Runner')[1];
  assert.ok(step);
  const fence = step.match(/```bash\r?\n([\s\S]*?)```/);
  assert.ok(fence);
  return fence[1];
}

for (const target of ['claude', 'claude-project']) {
  test(`standalone ${target} TDD detector uses the managed helper without a plugin variable`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecc tdd ' $() ` "));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'user project');
    const homeDir = path.join(root, 'private home');
    fs.mkdirSync(project);
    fs.mkdirSync(homeDir);
    fs.mkdirSync(path.join(project, 'scripts'));
    const sentinel = path.join(project, 'scripts', 'setup-package-manager.js');
    fs.writeFileSync(sentinel, 'USER SENTINEL\n');
    fs.writeFileSync(path.join(project, 'package.json'), '{"packageManager":"pnpm@10.0.0"}\n');
    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ECC_AGENT_DATA_HOME: path.join(root, 'data') };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_PACKAGE_MANAGER;
    const options = { target, moduleIds: ['workflow-quality'], projectRoot: project, homeDir, env };
    const plan = createManifestInstallPlan(options);
    applyInstallPlan(plan);
    const skillPath = path.join(plan.targetRoot, 'skills', 'tdd-workflow', 'SKILL.md');
    const code = detectorBlock(fs.readFileSync(skillPath, 'utf8'));
    const result = spawnSync('bash', ['-c', code], { cwd: project, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Package Manager: pnpm/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'USER SENTINEL\n');
    const lifecycle = { repoRoot: path.join(__dirname, '../..'), projectRoot: project, homeDir, targets: [target], env };
    assert.equal(repairInstalledStates(lifecycle).summary.errorCount, 0);
    const repaired = spawnSync('bash', ['-c', detectorBlock(fs.readFileSync(skillPath, 'utf8'))], { cwd: project, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(uninstallInstalledStates(lifecycle).summary.errorCount, 0);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'USER SENTINEL\n');
  });
}

test('canonical TDD detector retains source-checkout fallback with the plugin variable absent', t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc tdd source '));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const repo = path.join(__dirname, '../..');
  const code = detectorBlock(fs.readFileSync(path.join(repo, 'skills/tdd-workflow/SKILL.md'), 'utf8'));
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ECC_AGENT_DATA_HOME: path.join(homeDir, 'data') };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_PACKAGE_MANAGER;
  delete env.CLAUDE_CONFIG_DIR;
  const result = spawnSync('bash', ['-c', code], { cwd: repo, env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Package Manager:/);
});

test('plugin-root text stays data when its directory contains shell metacharacters', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc tdd substitution '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(__dirname, '../..');
  const plugin = path.join(root, "plugin$(touch${IFS}PWN)`echo quoted`' ");
  fs.mkdirSync(plugin);
  fs.cpSync(path.join(repo, 'scripts'), path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"packageManager":"pnpm@10.0.0"}\n');
  const code = detectorBlock(fs.readFileSync(path.join(repo, 'skills/tdd-workflow/SKILL.md'), 'utf8'));
  const env = { ...process.env, HOME: root, USERPROFILE: root, ECC_AGENT_DATA_HOME: path.join(root, 'data') };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_PACKAGE_MANAGER;
  delete env.CLAUDE_CONFIG_DIR;
  const rendered = code.split('${CLAUDE_PLUGIN_ROOT}').join(plugin.split(path.sep).join('/'));
  const result = spawnSync('bash', ['-c', rendered], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Package Manager: pnpm/);
  assert.equal(fs.existsSync(path.join(root, 'PWN')), false, 'a path must never execute shell text');
});

for (const resolution of ['rendered', 'environment']) {
  test(`resolved ${resolution} plugin root with missing detector never executes a project helper`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc tdd missing plugin '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const plugin = path.join(root, 'selected plugin');
    const project = path.join(root, 'project cwd');
    fs.mkdirSync(plugin);
    fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
    const marker = path.join(project, 'EXECUTED');
    const helper = path.join(project, 'scripts', 'setup-package-manager.js');
    const helperBytes = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('PROJECT_HELPER_EXECUTED');`;
    fs.writeFileSync(helper, helperBytes);
    const repo = path.join(__dirname, '../..');
    const code = detectorBlock(fs.readFileSync(path.join(repo, 'skills/tdd-workflow/SKILL.md'), 'utf8'));
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    if (resolution === 'environment') env.CLAUDE_PLUGIN_ROOT = plugin;
    const rendered = resolution === 'rendered' ? code.split('${CLAUDE_PLUGIN_ROOT}').join(plugin.split(path.sep).join('/')) : code;
    const result = spawnSync('bash', ['-c', rendered], { cwd: project, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, 'a selected missing plugin helper must fail visibly');
    assert.match(result.stderr, /MODULE_NOT_FOUND/);
    assert.equal(result.stdout.includes('PROJECT_HELPER_EXECUTED'), false);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(helper, 'utf8'), helperBytes);
    assert.equal(fs.existsSync(path.join(plugin, 'scripts')), false);
  });
}
