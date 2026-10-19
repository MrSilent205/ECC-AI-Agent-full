const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildValidationIssue,
  createInstallTargetAdapter,
  createManagedOperation,
  isForeignPlatformPath,
} = require('./helpers');
const { resolveOpencodeConfigRoot } = require('../opencode-paths');
const {
  CONFIG_ROOT_CHILDREN,
  HOOK_RUNTIME_PACKAGES,
  resolvePackageClosure,
} = require('../install/opencode-home-config');

// The npm package and `repair` rebuild .opencode/dist (scripts/build-opencode.js),
// which also regenerates the bridge's hook table, so a built tree is the
// signal that the plugin payload is complete. OpenCode itself loads the
// TypeScript sources in place.
const PLUGIN_SOURCE_DIR = '.opencode';
const COMPILED_PLUGIN_DIST_DIR = path.join(PLUGIN_SOURCE_DIR, 'dist');
const REQUIRED_COMPILED_ARTEFACTS = Object.freeze([
  { relativePath: path.join(COMPILED_PLUGIN_DIST_DIR, 'index.js'), expectedType: 'file' },
  { relativePath: path.join(COMPILED_PLUGIN_DIST_DIR, 'plugins'), expectedType: 'directory' },
]);
const PLUGIN_SOURCE_ARTEFACTS = Object.freeze([
  path.join(PLUGIN_SOURCE_DIR, 'plugins', 'ecc.ts'),
  path.join(PLUGIN_SOURCE_DIR, 'ecc', 'bridge', 'hook-table.generated.json'),
]);
const BUILD_COMMAND_HINT = 'node scripts/build-opencode.js (or: npm run build:opencode)';
// Errors that mean "this artefact does not exist at the expected path / type".
// Anything else (EACCES, EIO, ...) is a genuine system fault we surface to the
// caller rather than masking as a missing artefact.
const MISSING_ARTEFACT_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR']);

function isExpectedType(absolutePath, expectedType) {
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (error) {
    if (error && MISSING_ARTEFACT_ERROR_CODES.has(error.code)) {
      return false;
    }
    throw error;
  }
  return expectedType === 'file' ? stat.isFile() : stat.isDirectory();
}

function defaultValidateOpencodeHome(input = {}) {
  if (!input.homeDir && !os.homedir()) {
    return [
      buildValidationIssue(
        'error',
        'missing-home-dir',
        'homeDir is required for home install targets'
      ),
    ];
  }

  if (!input.repoRoot) {
    return [];
  }

  const missingPaths = REQUIRED_COMPILED_ARTEFACTS
    .map(artefact => ({
      relativePath: artefact.relativePath,
      absolutePath: path.join(input.repoRoot, artefact.relativePath),
      expectedType: artefact.expectedType,
    }))
    .filter(entry => !isExpectedType(entry.absolutePath, entry.expectedType));

  if (missingPaths.length > 0) {
    const missingList = missingPaths.map(entry => entry.relativePath).join(', ');
    return [
      buildValidationIssue(
        'error',
        'opencode-plugin-not-built',
        'OpenCode install requires the compiled plugin payload under '
          + `${COMPILED_PLUGIN_DIST_DIR}, but the following artefact(s) were `
          + `missing or had the wrong type: ${missingList}. Run `
          + `${BUILD_COMMAND_HINT} from the repo root before re-running the `
          + 'installer.',
        {
          missingPaths: missingPaths.map(entry => entry.absolutePath),
          missingRelativePaths: missingPaths.map(entry => entry.relativePath),
          expectedTypes: missingPaths.map(entry => entry.expectedType),
        }
      ),
    ];
  }

  const missingSources = PLUGIN_SOURCE_ARTEFACTS.filter(relativePath => (
    !isExpectedType(path.join(input.repoRoot, relativePath), 'file')
  ));
  if (missingSources.length > 0) {
    return [
      buildValidationIssue(
        'warning',
        'opencode-plugin-source-missing',
        `OpenCode plugin source file(s) missing: ${missingSources.join(', ')}. `
          + 'The installed plugin will not load until they are restored.',
        { missingRelativePaths: missingSources }
      ),
    ];
  }

  return [];
}

/**
 * Operations for the `.opencode` payload: the config-root children, plus a
 * merge of ECC's agents and commands into the user's opencode.json. Merging
 * (instead of copying) keeps the user's own settings and other plugins'
 * entries, e.g. OpenCode Ensemble's `plugins` and `permissions` rules, and
 * lets uninstall remove exactly what ECC added.
 */
function planConfigRootOperations(moduleId, root) {
  return [
    ...CONFIG_ROOT_CHILDREN.map(child => createManagedOperation({
      moduleId,
      sourceRelativePath: `${PLUGIN_SOURCE_DIR}/${child}`,
      destinationPath: path.join(root, child),
      strategy: 'preserve-relative-path',
    })),
    createManagedOperation({
      kind: 'merge-json',
      moduleId,
      sourceRelativePath: `${PLUGIN_SOURCE_DIR}/opencode.json`,
      destinationPath: path.join(root, 'opencode.json'),
      strategy: 'merge-json',
      contentTransform: 'opencode-home-config',
    }),
  ];
}

function planHookRuntimePackageOperations(moduleId, root, sourceRoot) {
  if (!sourceRoot) return [];
  return resolvePackageClosure(sourceRoot, HOOK_RUNTIME_PACKAGES).map(name => createManagedOperation({
    moduleId,
    sourceRelativePath: `node_modules/${name}`,
    destinationPath: path.join(root, 'scripts', 'node_modules', ...name.split('/')),
    strategy: 'preserve-relative-path',
  }));
}

module.exports = createInstallTargetAdapter({
  id: 'opencode-home',
  target: 'opencode',
  kind: 'home',
  rootSegments: ['.config', 'opencode'],
  resolveRoot: resolveOpencodeConfigRoot,
  installStatePathSegments: ['ecc-install-state.json'],
  nativeRootRelativePath: '.opencode',
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
    const root = adapter.resolveRoot(input);
    const operations = modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
      .filter(sourcePath => !isForeignPlatformPath(sourcePath, adapter.target))
      .flatMap(sourcePath => {
        const operation = adapter.createScaffoldOperation(module.id, sourcePath, input);
        if (operation.sourceRelativePath !== PLUGIN_SOURCE_DIR) {
          return [operation];
        }
        return planConfigRootOperations(module.id, root);
      }));
    const scriptOperation = operations.find(operation => (
      String(operation.sourceRelativePath).replace(/\\/g, '/').startsWith('scripts/')
    ));
    if (!scriptOperation) return operations;
    // OpenCode's root is ESM, while ECC runtime scripts remain CommonJS.
    // Record this boundary so install, repair and uninstall share ownership.
    return [
      ...operations,
      createManagedOperation({
        moduleId: scriptOperation.moduleId,
        sourceRelativePath: 'manifests/install-assets/commonjs-scripts-package.json',
        destinationPath: path.join(root, 'scripts', 'package.json'),
        strategy: 'preserve-relative-path',
      }),
      ...planHookRuntimePackageOperations(scriptOperation.moduleId, root, input.repoRoot),
    ];
  },
  validate: defaultValidateOpencodeHome,
});
