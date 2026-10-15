'use strict';

const fs = require('fs');
const path = require('path');

const { readInstallState } = require('../install-state');
const { hasEditedCodexUserConfig } = require('./codex-user-config');
const {
  isOpenCodeConfigTemplateOperation,
  parseJsonObjectContent,
  readExistingConfigContent,
} = require('./opencode-config-merge');

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function comparablePath(filePath) {
  const resolvedPath = path.resolve(filePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

/**
 * #3559: ECC's own OpenCode config template is a managed copy-file operation
 * whose destination is the user's live `opencode.json`. Dropping the whole
 * template (the #2964 behavior below) leaves the install without agents,
 * commands or skills paths, so for this one mergeable JSON config the guard
 * instead plans a merge: the template keys are combined into the existing
 * document, the user's keys stay untouched, and the pre-merge content is
 * recorded on the operation (previousContent) so uninstall can restore it.
 * Returns null whenever the existing file is not a JSON object ECC can merge
 * into; those files keep full #2964 skip treatment.
 */
function prepareExistingConfigMerge(operation) {
  if (!isOpenCodeConfigTemplateOperation(operation) || !operation.sourcePath) {
    return null;
  }
  const existingContent = readExistingConfigContent(operation.destinationPath);
  if (existingContent === null || parseJsonObjectContent(existingContent) === null) {
    return null;
  }
  return { ...operation, previousContent: existingContent };
}

/**
 * #2964: the shared copy path used to write every copy-file operation
 * unconditionally and record the destination as `ownership: 'managed'` even
 * when the file already existed and was authored by the user. The visible
 * symptom is a lost edit; the dangerous one is the install-state record,
 * which makes a later uninstall delete the user's file.
 *
 * This guard generalises the Claude flat-skill migration conflict pattern to
 * every adapter copy operation: when a destination exists and is NOT recorded
 * as an ECC-managed operation in the previous install-state, the operation is
 * skipped with a warning instead of overwriting and claiming ownership.
 *
 * All managed targets share this ownership boundary (#2964).
 */
/**
 * Decides per planned/retained operation whether the #2964 skip applies,
 * an existing OpenCode config is merged into instead (#3559), or the
 * operation passes through untouched. Returns destination-keyed decisions so
 * the caller can rewrite the migration without relying on object identity.
 */
function classifyUnrecordedFileConflicts(plan, plannedOperations, retainedOperations, managedDestinations, previousManagedOperations) {
  const skippedOperations = [];
  const warnings = [];
  const mergedOperations = new Map();
  for (const operation of [...plannedOperations, ...retainedOperations]) {
    const previousOperation = previousManagedOperations.get(comparablePath(operation.destinationPath));
    const editedConfig = previousOperation
      && hasEditedCodexUserConfig(plan, operation, previousOperation);
    const conflictsWithUnrecordedFile = Boolean(
      operation
      && operation.kind === 'copy-file'
      && operation.destinationPath
      && pathExists(operation.destinationPath)
      && (!managedDestinations.has(comparablePath(operation.destinationPath)) || editedConfig)
    );
    if (conflictsWithUnrecordedFile && isOpenCodeConfigTemplateOperation(operation)) {
      const mergedOperation = prepareExistingConfigMerge(operation);
      if (mergedOperation) {
        mergedOperations.set(comparablePath(operation.destinationPath), mergedOperation);
        continue;
      }
    }
    if (conflictsWithUnrecordedFile) {
      skippedOperations.push(operation);
      warnings.push(editedConfig
        ? `Preserved user configuration ${operation.destinationPath}: changed or unverifiable since installation. ECC no longer manages this file; apply future configuration updates manually.`
        : `Skipped user-owned file ${operation.destinationPath}: the existing file is not recorded in ECC install-state.`);
    }
  }
  return { skippedOperations, warnings, mergedOperations };
}

function prepareUserOwnedFileGuard(plan, migration, recordedState) {
  const previousState = recordedState === undefined
    ? (pathExists(plan.installStatePath) ? readInstallState(plan.installStatePath) : null)
    : recordedState;
  if (previousState && (
    previousState.target.id !== plan.adapter.id
    || comparablePath(previousState.target.root) !== comparablePath(plan.targetRoot)
    || comparablePath(previousState.target.installStatePath) !== comparablePath(plan.installStatePath)
  )) {
    throw new Error(`Refusing install: install-state target does not match the current plan at ${plan.installStatePath}.`);
  }
  // Recorded files remain updateable by reinstall/repair. Preserve their prior
  // digests if an attempt fails before writing them so uninstall detects drift.
  const previousManagedOperations = new Map(
    ((previousState && previousState.operations) || [])
      .filter(operation => (
        operation
        && operation.ownership === 'managed'
        && operation.destinationPath
      ))
      .map(operation => [comparablePath(operation.destinationPath), operation])
  );
  const managedDestinations = new Set(previousManagedOperations.keys());

  const plannedOperations = (migration && migration.appliedOperations) || [];
  const plannedDestinations = new Set(plannedOperations.map(operation => comparablePath(operation.destinationPath)));
  // Selective reinstalls retain earlier modules in the ledger. Inspect those
  // entries too, without turning them into additional writes in this install.
  const retainedOperations = ((migration.finalState && migration.finalState.operations) || [])
    .filter(operation => !plannedDestinations.has(comparablePath(operation.destinationPath))
      && previousManagedOperations.has(comparablePath(operation.destinationPath)));
  const { skippedOperations, warnings, mergedOperations } = classifyUnrecordedFileConflicts(
    plan,
    plannedOperations,
    retainedOperations,
    managedDestinations,
    previousManagedOperations
  );

  const replaceMerged = operations => (operations || []).map(operation => (
    mergedOperations.get(comparablePath(operation.destinationPath)) || operation
  ));
  // A recorded config keeps the snapshot from the install that first merged
  // into the user's document: uninstall must always be able to restore the
  // pre-ECC content, not just after the initial merge (#3559).
  const withCarriedSnapshot = operations => (operations || []).map(operation => {
    if (!isOpenCodeConfigTemplateOperation(operation)
      || typeof operation.previousContent === 'string') {
      return operation;
    }
    const recorded = previousManagedOperations.get(comparablePath(operation.destinationPath));
    return recorded && typeof recorded.previousContent === 'string'
      ? { ...operation, previousContent: recorded.previousContent }
      : operation;
  });
  const carriesSnapshot = plannedOperations.some(operation => {
    if (!isOpenCodeConfigTemplateOperation(operation)
      || typeof operation.previousContent === 'string') {
      return false;
    }
    const recorded = previousManagedOperations.get(comparablePath(operation.destinationPath));
    return Boolean(recorded && typeof recorded.previousContent === 'string');
  });

  if (skippedOperations.length === 0 && mergedOperations.size === 0 && !carriesSnapshot) {
    return { ...migration, managedDestinations, previousManagedOperations };
  }

  for (const [destinationKey, mergedOperation] of mergedOperations) {
    // The merge claims ECC ownership of the combined document, so the write
    // boundary must not refuse it as a user file that appeared after planning.
    managedDestinations.add(destinationKey);
    warnings.push(
      `Merged ECC configuration into existing file ${mergedOperation.destinationPath}: `
      + 'your existing keys are preserved and the previous content was recorded '
      + 'so uninstall can restore it.'
    );
  }
  const skippedDestinations = new Set(
    skippedOperations.map(operation => comparablePath(operation.destinationPath))
  );
  const appliedOperations = withCarriedSnapshot(replaceMerged(plannedOperations)).filter(operation => (
    !skippedDestinations.has(comparablePath(operation.destinationPath))
  ));
  const filterStateOperations = operations => withCarriedSnapshot(replaceMerged(operations))
    .filter(operation => !skippedDestinations.has(comparablePath(operation.destinationPath)));

  // Never leave a skipped destination inside the install-state: recording it
  // would claim ownership of a file ECC did not create and make uninstall
  // delete it (#2964). Merged destinations stay recorded with their
  // previousContent snapshot so uninstall can restore the user's document
  // (#3559).
  const bridgeState = migration.bridgeState
    ? {
      ...migration.bridgeState,
      operations: filterStateOperations(migration.bridgeState.operations),
    }
    : migration.bridgeState;
  const finalState = migration.finalState
    ? {
      ...migration.finalState,
      operations: filterStateOperations(migration.finalState.operations),
    }
    : migration.finalState;

  return {
    ...migration,
    managedDestinations,
    previousManagedOperations,
    appliedOperations,
    skippedOperations: [
      ...((migration && migration.skippedOperations) || []),
      ...skippedOperations,
    ],
    warnings: [...((migration && migration.warnings) || []), ...warnings],
    bridgeState,
    finalState,
    // Only keep bridge persistence when operations actually remain; a fully
    // skipped plan installs nothing and must not claim anything. Plans that
    // were not filtered keep the migration's own bridge decision.
    requiresBridgeState: skippedOperations.length > 0
      ? Boolean(migration.requiresBridgeState) && appliedOperations.length > 0
      : migration.requiresBridgeState,
  };
}

function assertNoNewUserOwnedFile(migration, operation, plan) {
  const previousOperation = migration.previousManagedOperations.get(comparablePath(operation.destinationPath));
  if (plan && hasEditedCodexUserConfig(plan, operation, previousOperation)) {
    throw new Error(`Refusing to overwrite user configuration changed after planning: ${operation.destinationPath}. Rerun to preserve it.`);
  }
  if (operation.kind !== 'copy-file'
    || migration.managedDestinations.has(comparablePath(operation.destinationPath))
    || !pathExists(operation.destinationPath)) {
    return;
  }
  throw new Error(`Refusing install: a user-owned file appeared at ${operation.destinationPath} after planning. Rerun the installer to preserve it.`);
}

function preserveUnwrittenFiles(state, migration, writtenDestinations) {
  const writtenPaths = new Set([...writtenDestinations].map(comparablePath));
  return {
    ...state,
    operations: state.operations.filter(operation => (
      operation.kind !== 'copy-file'
      || migration.managedDestinations.has(comparablePath(operation.destinationPath))
      || writtenPaths.has(comparablePath(operation.destinationPath))
      || !pathExists(operation.destinationPath)
    )).map(operation => {
      const destination = comparablePath(operation.destinationPath);
      return operation.kind === 'copy-file' && !writtenPaths.has(destination)
        ? migration.previousManagedOperations.get(destination) || operation
        : operation;
    }),
  };
}

module.exports = {
  assertNoNewUserOwnedFile,
  prepareUserOwnedFileGuard,
  preserveUnwrittenFiles,
};
