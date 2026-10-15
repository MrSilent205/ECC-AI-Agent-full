'use strict';

const fs = require('fs');

const { deepMergeJson, formatJson, isPlainObject } = require('./json-ops');

// ECC ships its OpenCode agent/command/plugin wiring inside the config
// template `.opencode/opencode.json`, which the opencode-home target plans as
// a managed copy-file operation. Machines that already have an
// `opencode.json` hit the #2964 ownership guard, which dropped the whole
// template and left installs without agents, commands or skills paths
// (issue #3559). The template is mergeable JSON, so ECC-owned keys can be
// combined into an existing config while user-owned keys stay untouched; the
// pre-merge content is recorded on the install-state operation so uninstall
// can restore it.

function normalizeSourceRelativePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isOpenCodeConfigTemplateOperation(operation) {
  return Boolean(operation)
    && operation.kind === 'copy-file'
    && normalizeSourceRelativePath(operation.sourceRelativePath) === '.opencode/opencode.json';
}

function parseJsonObjectContent(rawContent) {
  if (typeof rawContent !== 'string') {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (_error) {
    return null;
  }

  return isPlainObject(parsed) ? parsed : null;
}

function readExistingConfigContent(destinationPath) {
  try {
    return fs.readFileSync(destinationPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// The plugin array is ECC's hook activation surface but may also carry the
// user's own plugin registrations. When merging into a document ECC has never
// recorded, union the entries instead of letting the template overwrite them,
// and omit the key entirely when both sides are empty so inactive configs
// gain no activation machinery. Recorded destinations (reinstall/repair over
// digest-verified ECC bytes) use the plain merge so a declined template can
// remove the './plugins' entry ECC itself wrote earlier.
function mergePluginEntries(baseValue, patchValue) {
  const entries = [];
  for (const value of [baseValue, patchValue]) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (!entries.includes(entry)) {
        entries.push(entry);
      }
    }
  }
  return entries;
}

// Returns the merged JSON document to install, or null when either side is
// not a JSON object (the caller then keeps today's behavior instead of
// corrupting a file it cannot parse).
function mergeOpenCodeConfigContent(existingRawContent, incomingRawContent, options = {}) {
  const existingValue = parseJsonObjectContent(existingRawContent);
  if (existingValue === null) {
    return null;
  }

  const incomingValue = parseJsonObjectContent(incomingRawContent);
  if (incomingValue === null) {
    return null;
  }

  const mergedValue = deepMergeJson(existingValue, incomingValue);
  if (options.preserveUserPluginEntries) {
    const plugin = mergePluginEntries(existingValue.plugin, incomingValue.plugin);
    if (plugin.length > 0) {
      mergedValue.plugin = plugin;
    } else {
      delete mergedValue.plugin;
    }
  }
  return formatJson(mergedValue);
}

module.exports = {
  isOpenCodeConfigTemplateOperation,
  mergeOpenCodeConfigContent,
  parseJsonObjectContent,
  readExistingConfigContent,
};
