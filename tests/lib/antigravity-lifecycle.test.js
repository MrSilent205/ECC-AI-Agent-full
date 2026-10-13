'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createManifestInstallPlan } = require('../../scripts/lib/install/plan');
const { applyInstallPlan } = require('../../scripts/lib/install/apply');
const { withHookConsent } = require('../../scripts/lib/install/hook-consent');
const { buildDoctorReport, repairInstalledStates } = require('../../scripts/lib/install-lifecycle');

const repoRoot = path.join(__dirname, '..', '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-lifecycle-'));
const homeDir = path.join(fixtureRoot, 'home');
const projectRoot = path.join(fixtureRoot, 'project');

try {
  fs.mkdirSync(homeDir);
  fs.mkdirSync(projectRoot);
  const plan = withHookConsent(createManifestInstallPlan({
    profileId: 'core',
    target: 'antigravity-home',
    homeDir,
    projectRoot,
  }), 'enabled');
  const workflowPath = path.join(homeDir, '.gemini', 'config', 'workflows', 'plan.md');
  const workflowOperation = {
    kind: 'copy-file',
    moduleId: 'commands-core',
    sourcePath: path.join(repoRoot, 'commands', 'plan.md'),
    sourceRelativePath: 'commands/plan.md',
    destinationPath: workflowPath,
    strategy: 'preserve-relative-path',
    ownership: 'managed',
    scaffoldOnly: false,
  };
  applyInstallPlan({
    ...plan,
    operations: [...plan.operations, workflowOperation],
    statePreview: {
      ...plan.statePreview,
      operations: [...plan.statePreview.operations, workflowOperation],
    },
  });

  const original = fs.readFileSync(workflowPath, 'utf8');
  fs.unlinkSync(workflowPath);

  const doctor = buildDoctorReport({
    repoRoot,
    homeDir,
    projectRoot,
    targets: ['antigravity-home'],
  }).results[0];
  assert.ok(!doctor.issues.some(issue => issue.code === 'unsafe-managed-destination'));

  const repaired = repairInstalledStates({
    repoRoot,
    homeDir,
    projectRoot,
    targets: ['antigravity-home'],
  }).results[0];
  assert.strictEqual(repaired.status, 'repaired', repaired.error);
  assert.strictEqual(fs.readFileSync(workflowPath, 'utf8'), original);

  const outsidePath = path.join(homeDir, 'outside.md');
  fs.writeFileSync(outsidePath, 'user content');
  fs.unlinkSync(workflowPath);
  fs.symlinkSync(outsidePath, workflowPath);
  const refused = repairInstalledStates({
    repoRoot,
    homeDir,
    projectRoot,
    targets: ['antigravity-home'],
  }).results[0];
  assert.strictEqual(refused.status, 'error');
  assert.match(refused.error, /unsafe managed destination|symlink/i);
  assert.strictEqual(fs.readFileSync(outsidePath, 'utf8'), 'user content');
  console.log('Results: Passed: 3, Failed: 0');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
