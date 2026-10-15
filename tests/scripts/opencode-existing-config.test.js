'use strict';

/**
 * Tests for issue #3559: installing the OpenCode target onto a machine that
 * already has an `opencode.json` must merge ECC's config template into the
 * existing file (agents, commands, plugin wiring, skills paths) instead of
 * skipping the whole config, while user-owned keys survive and uninstall can
 * restore the pre-merge content.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createManifestInstallPlan } = require('../../scripts/lib/install/plan');
const { applyInstallPlan, previewInstallPlan } = require('../../scripts/lib/install/apply');
const { uninstallInstalledStates } = require('../../scripts/lib/install-lifecycle');
const { transformInstallContent } = require('../../scripts/lib/install/content-transform');
const {
  mergeOpenCodeConfigContent,
  parseJsonObjectContent,
} = require('../../scripts/lib/install/opencode-config-merge');

let passed = 0;
let failed = 0;
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-opencode-config-'));
  try {
    const projectRoot = path.join(root, 'project');
    const homeDir = path.join(root, 'home');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(homeDir);
    fn({ projectRoot, homeDir });
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readState(plan) {
  return JSON.parse(fs.readFileSync(plan.installStatePath, 'utf8'));
}

function readConfig(destinationPath) {
  return JSON.parse(fs.readFileSync(destinationPath, 'utf8'));
}

const USER_CONFIG = {
  model: 'openai/gpt-5',
  theme: 'ocean',
  mcp: {
    'user-server': {
      type: 'local',
      command: ['npx', '-y', 'user-mcp-server'],
    },
  },
  agent: {
    'user-agent': {
      description: "User's own helper",
      mode: 'subagent',
    },
  },
};

// platform-configs keeps the hook runtime out of the plan, so the OpenCode
// activation operations carry their disabled transforms and no consent gate
// applies (same approach as tests/scripts/ownership-guard.test.js).
function createOpencodePlan(context) {
  return createManifestInstallPlan({
    ...context,
    target: 'opencode',
    moduleIds: ['platform-configs'],
    exemptValidationCodes: ['opencode-plugin-not-built'],
  });
}

function findConfigOperation(plan) {
  const operation = plan.operations.find(item => (
    item.kind === 'copy-file'
    && String(item.sourceRelativePath).replace(/\\/g, '/') === '.opencode/opencode.json'
  ));
  assert.ok(operation, 'opencode plan must include the managed config template operation');
  return operation;
}

function writeUserConfig(destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, `${JSON.stringify(USER_CONFIG, null, 2)}\n`);
}

function assertEccKeysMerged(config) {
  assert.ok(config.agent && config.agent.planner, 'merged config must define the planner agent');
  assert.ok(config.agent['user-agent'], 'merged config must keep user-defined agents');
  assert.ok(config.command && config.command.plan, 'merged config must define commands');
  assert.ok(config.skills && Array.isArray(config.skills.paths)
    && config.skills.paths.includes('./skills'), 'merged config must point skills at the config root');
  assert.strictEqual(config.model, USER_CONFIG.model, 'user model key must be preserved');
  assert.strictEqual(config.theme, USER_CONFIG.theme, 'user theme key must be preserved');
  assert.ok(config.mcp && config.mcp['user-server'], 'user mcp servers must be preserved');
}

test('merge combines template keys into an existing config without losing user keys', context => {
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);

  const installed = applyInstallPlan(plan);
  assert.ok(!installed.skippedOperations.some(item => item.destinationPath === operation.destinationPath),
    'the config must not be skipped');
  assert.ok(installed.warnings.some(warning => warning.includes('Merged ECC configuration')),
    'the merge must be reported');
  assertEccKeysMerged(readConfig(operation.destinationPath));

  const state = readState(plan);
  const recorded = state.operations.find(item => item.destinationPath === operation.destinationPath);
  assert.ok(recorded, 'the merged config must be recorded in install-state');
  assert.strictEqual(recorded.previousContent, `${JSON.stringify(USER_CONFIG, null, 2)}\n`,
    'the pre-merge content must be recorded for uninstall');
  assert.ok(/^[a-f0-9]{64}$/.test(recorded.contentSha256 || ''), 'the merged content must be digested');
});

test('preview reports the merge without writing state or files', context => {
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);

  const preview = previewInstallPlan(plan);
  assert.ok(!preview.skippedOperations.some(item => item.destinationPath === operation.destinationPath),
    'preview must not skip the config');
  assert.ok(preview.warnings.some(warning => warning.includes('Merged ECC configuration')),
    'preview must announce the merge');
  assert.deepStrictEqual(readConfig(operation.destinationPath), USER_CONFIG,
    'preview must not touch the existing config');
  assert.ok(!fs.existsSync(plan.installStatePath), 'preview must not create state');
});

test('reinstall merges again and keeps the user keys from the existing config', context => {
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);
  applyInstallPlan(plan);

  applyInstallPlan(plan);
  const reinstalled = readConfig(operation.destinationPath);
  assert.strictEqual(reinstalled.model, USER_CONFIG.model, 'user model key must survive reinstall');
  assert.ok(reinstalled.agent && reinstalled.agent.planner, 'ECC keys must be restored on reinstall');
  assert.ok(reinstalled.agent['user-agent'], 'user agents must survive reinstall');
  const recorded = readState(plan).operations.find(item => item.destinationPath === operation.destinationPath);
  assert.strictEqual(recorded.previousContent, `${JSON.stringify(USER_CONFIG, null, 2)}\n`,
    'reinstall must keep the original pre-merge snapshot for uninstall');
});

test('uninstall restores the exact pre-merge user content', context => {
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);
  applyInstallPlan(plan);
  assert.ok(readConfig(operation.destinationPath).agent, 'precondition: ECC keys installed');

  const result = uninstallInstalledStates({ ...context, targets: ['opencode'] });
  assert.strictEqual(result.summary.errorCount, 0);
  assert.strictEqual(fs.readFileSync(operation.destinationPath, 'utf8'),
    `${JSON.stringify(USER_CONFIG, null, 2)}\n`,
    'uninstall must restore the pre-merge user config byte for byte');
  assert.ok(!fs.existsSync(plan.installStatePath));
});

test('uninstall preserves a drifted merged config instead of restoring stale content', context => {
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);
  applyInstallPlan(plan);

  const drifted = readConfig(operation.destinationPath);
  drifted.model = 'user/edited-after-install';
  fs.writeFileSync(operation.destinationPath, `${JSON.stringify(drifted, null, 2)}\n`);

  const result = uninstallInstalledStates({ ...context, targets: ['opencode'] });
  assert.strictEqual(result.summary.errorCount, 0);
  assert.strictEqual(readConfig(operation.destinationPath).model, 'user/edited-after-install',
    'uninstall must not clobber user edits made after the merged install');
  assert.ok(readConfig(operation.destinationPath).mcp, 'user keys must remain in the drifted config');
});

test('repair merges the template so user keys survive', context => {
  const { repairInstalledStates } = require('../../scripts/lib/install-lifecycle');
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);
  applyInstallPlan(plan);

  const result = repairInstalledStates({ ...context, targets: ['opencode'] });
  assert.strictEqual(result.summary.errorCount, 0);
  const repaired = readConfig(operation.destinationPath);
  assert.ok(repaired.agent && repaired.agent.planner, 'repair must keep ECC keys');
  assert.strictEqual(repaired.model, USER_CONFIG.model, 'repair must keep user keys');
  assert.ok(repaired.mcp && repaired.mcp['user-server'], 'repair must keep user mcp servers');
});

test('merge helpers refuse non-object documents so the guard can fall back to skip', () => {
  assert.strictEqual(parseJsonObjectContent('["array"]'), null);
  assert.strictEqual(parseJsonObjectContent('"scalar"'), null);
  assert.strictEqual(parseJsonObjectContent('{ broken'), null);
  assert.strictEqual(mergeOpenCodeConfigContent('["array"]', '{"a":1}'), null,
    'non-object destinations must not be merged');
  assert.strictEqual(mergeOpenCodeConfigContent('{"a":1}', 'not json'), null,
    'unparseable template output must not be merged');
  // Non-object or unparseable existing configs therefore keep the #2964 skip
  // treatment (or the activation preflight's fail-closed refusal when hook
  // consent was declined) — both pre-existing behaviors for files ECC cannot
  // safely rewrite.
});

test('a fresh install still writes the transformed template as before', context => {
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  applyInstallPlan(plan);

  const config = readConfig(operation.destinationPath);
  assert.ok(config.agent && config.agent.planner, 'fresh install must write the agents');
  assert.deepStrictEqual(config.skills.paths, ['./skills'],
    'fresh install must keep the skills path transform');
  assert.ok(!('model' in config), 'fresh install must not invent user keys');
  const recorded = readState(plan).operations.find(item => item.destinationPath === operation.destinationPath);
  assert.ok(recorded, 'fresh install records ownership');
  assert.strictEqual(recorded.previousContent, undefined,
    'fresh installs have no pre-existing content to restore');
});

test('merge honors the disabled-activation transform for declined hook consent', () => {
  const rawTemplate = fs.readFileSync(
    path.join(__dirname, '..', '..', '.opencode', 'opencode.json'), 'utf8');
  const disabled = transformInstallContent({
    contentTransform: 'opencode-disable-ecc-hooks',
    sourceRelativePath: '.opencode/opencode.json',
  }, rawTemplate);
  const merged = JSON.parse(mergeOpenCodeConfigContent(
    JSON.stringify(USER_CONFIG), disabled, { preserveUserPluginEntries: true }));
  assert.ok(merged.agent && merged.agent.planner);
  assert.strictEqual(merged.plugin, undefined,
    'a user config without plugin registrations gains no activation machinery');
  const withUserPlugins = JSON.parse(mergeOpenCodeConfigContent(
    JSON.stringify({ ...USER_CONFIG, plugin: ['user-plugin', './plugins'] }), disabled,
    { preserveUserPluginEntries: true }));
  assert.deepStrictEqual(withUserPlugins.plugin, ['user-plugin', './plugins'],
    'the unrecorded merge must not strip plugin entries the user registered themselves');

  // Recorded destinations (reinstall/repair) follow the template so a declined
  // install removes the './plugins' entry ECC itself wrote earlier.
  const recorded = JSON.parse(mergeOpenCodeConfigContent(
    JSON.stringify({ ...USER_CONFIG, plugin: ['./plugins'] }), disabled));
  assert.deepStrictEqual(recorded.plugin, [], 'recorded deactivation removes the ECC entry');
  assert.ok(parseJsonObjectContent('[]') === null, 'only JSON objects are mergeable');
});

test('health reports a correct merged config as unchanged and repair stays idempotent', context => {
  const { repairInstalledStates } = require('../../scripts/lib/install-lifecycle');
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);
  applyInstallPlan(plan);

  // The installed merged config matches the recorded digest byte for byte.
  // Health must recognize it as unchanged — the deactivating transform's
  // expectation is the merged document, not the bare transformed template —
  // so repair has nothing to rewrite and never reports drift again.
  const first = repairInstalledStates({ ...context, targets: ['opencode'] });
  assert.strictEqual(first.summary.errorCount, 0);
  assert.strictEqual(first.results[0].status, 'ok',
    'a correct merged config must not be reported as drifted');
  assert.deepStrictEqual(first.results[0].repairedPaths, [],
    'a correct merged config must not be rewritten');

  const second = repairInstalledStates({ ...context, targets: ['opencode'] });
  assert.strictEqual(second.summary.errorCount, 0);
  assert.strictEqual(second.results[0].status, 'ok',
    'repair must stay idempotent for a merged config');
  assert.deepStrictEqual(second.results[0].repairedPaths, [],
    'an already-correct merged config must not be rewritten again');
});

test('uninstall keeps user edits after a repair rewrote a drifted merged config', context => {
  const { repairInstalledStates } = require('../../scripts/lib/install-lifecycle');
  const plan = createOpencodePlan(context);
  const operation = findConfigOperation(plan);
  writeUserConfig(operation.destinationPath);
  applyInstallPlan(plan);

  const edited = readConfig(operation.destinationPath);
  edited.model = 'user/edited-after-install';
  fs.writeFileSync(operation.destinationPath, `${JSON.stringify(edited, null, 2)}\n`);

  const result = repairInstalledStates({ ...context, targets: ['opencode'] });
  assert.strictEqual(result.summary.errorCount, 0);
  assert.strictEqual(readConfig(operation.destinationPath).model, 'user/edited-after-install',
    'repair must merge the template into the user-edited config');

  const uninstallResult = uninstallInstalledStates({ ...context, targets: ['opencode'] });
  assert.strictEqual(uninstallResult.summary.errorCount, 0);
  assert.strictEqual(readConfig(operation.destinationPath).model, 'user/edited-after-install',
    'uninstall must not treat the repaired merged config as installer-owned bytes and restore stale content');
  assert.ok(readConfig(operation.destinationPath).mcp, 'user keys must remain after uninstall');
});

console.log(`Results: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
