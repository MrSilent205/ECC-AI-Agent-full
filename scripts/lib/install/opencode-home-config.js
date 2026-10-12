'use strict';

/**
 * The part of .opencode/opencode.json that an OpenCode home install merges
 * into the user's ~/.config/opencode/opencode.json: ECC's agents and commands.
 *
 * Everything else is left to the user. `skills` is dropped because OpenCode
 * scans <config>/skills itself and resolves relative skill paths against the
 * project directory, not the config file. `default_agent` and `$schema` would
 * override the user's own choices. Legacy v1 keys (`instructions`, `plugin`,
 * `permission`) are dropped: v2 ignores `instructions` (the plugin injects
 * ECC's instructions), discovers plugins from <config>/plugins, and the old
 * `mcp_*` permission rule matches nothing in v2. The result has no arrays, so
 * merging it never replaces arrays the user or another plugin owns.
 *
 * Dependency-free on purpose: install planning must not load npm packages.
 */
const fs = require('fs');
const path = require('path');

const OPENCODE_HOME_CONFIG_TRANSFORM = 'opencode-home-config';

// Children of .opencode/ that belong in an OpenCode config root. Everything
// else there (package.json, package-lock.json, tsconfig.json, index.ts, dist/,
// README.md, MIGRATION.md) is the npm package's build surface: copying
// package.json over ~/.config/opencode/package.json clobbered OpenCode's own
// dependency manifest, and the other files are dead weight in a config root.
// The plugin entrypoint goes last so its helpers exist before it can load.
const CONFIG_ROOT_CHILDREN = Object.freeze(['ecc', 'commands', 'prompts', 'instructions', 'plugins']);
// npm packages the shared hook scripts require at runtime (see
// scripts/lib/project-detect.js and scripts/lib/context-profile-support.js).
// Copied with their dependency closure into <root>/scripts/node_modules, which
// Node resolves from <root>/scripts/{hooks,lib}.
const HOOK_RUNTIME_PACKAGES = Object.freeze(['js-yaml', 'ajv']);

function projectOpenCodeHomeConfig(content) {
  const config = JSON.parse(content);
  const projected = {};
  for (const key of ['agent', 'command']) {
    if (config && config[key] && typeof config[key] === 'object' && !Array.isArray(config[key])) {
      projected[key] = config[key];
    }
  }
  return `${JSON.stringify(projected, null, 2)}\n`;
}

/**
 * Resolve `names` and their production dependencies from the source tree's
 * node_modules. Packages that are not installed there are skipped: the hook
 * bridge fails open, so a missing optional dependency only degrades the hooks
 * that need it.
 */
function resolvePackageClosure(sourceRoot, names) {
  const nodeModules = path.join(sourceRoot, 'node_modules');
  const resolved = [];
  const queue = [...names];
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const manifestPath = path.join(nodeModules, ...name.split('/'), 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_error) {
      continue;
    }
    resolved.push(name);
    queue.push(...Object.keys(manifest.dependencies || {}));
  }
  return resolved.sort();
}

module.exports = {
  CONFIG_ROOT_CHILDREN,
  HOOK_RUNTIME_PACKAGES,
  OPENCODE_HOME_CONFIG_TRANSFORM,
  projectOpenCodeHomeConfig,
  resolvePackageClosure,
};
