'use strict';

const fs = require('fs');
const { isDeepStrictEqual } = require('util');

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

// An empty `plugin` array activates nothing, so a document that omits the key
// and one that carries `plugin: []` describe the same configuration state:
// the unrecorded merge omits the key, the recorded merge writes `[]`.
function normalizeEmptyPluginKey(value) {
  if (!isPlainObject(value) || !Array.isArray(value.plugin) || value.plugin.length > 0) {
    return value;
  }
  const { plugin: _emptyPlugin, ...rest } = value;
  return rest;
}

// Desired state for the merged OpenCode config is "ECC's keys match the
// (transformed) template, user keys are arbitrary" — not byte equality with
// the template. The live document matches exactly when merging the template
// into it changes nothing. Non-object documents fall back to a byte compare.
function mergedOpenCodeConfigMatchesDesiredState(liveRawContent, expectedTemplateContent) {
  const liveValue = parseJsonObjectContent(liveRawContent);
  const templateValue = parseJsonObjectContent(expectedTemplateContent);
  if (liveValue === null || templateValue === null) {
    return liveRawContent === expectedTemplateContent;
  }
  const live = normalizeEmptyPluginKey(liveValue);
  const template = normalizeEmptyPluginKey(templateValue);
  return isDeepStrictEqual(deepMergeJson(live, template), live);
}

// Recursively project the user-owned slice of a live merged config: values
// that deep-equal the (transformed) template are ECC-owned and dropped, keys
// the template does not define and values that diverged from it are kept.
// The projection is empty when every live key still matches the template.
function projectUserOwnedConfigKeys(liveValue, templateValue) {
  const projection = {};
  for (const [key, liveEntry] of Object.entries(liveValue)) {
    if (!Object.prototype.hasOwnProperty.call(templateValue, key)) {
      projection[key] = liveEntry;
      continue;
    }
    const templateEntry = templateValue[key];
    if (isPlainObject(liveEntry) && isPlainObject(templateEntry)) {
      const nested = projectUserOwnedConfigKeys(liveEntry, templateEntry);
      if (Object.keys(nested).length > 0) {
        projection[key] = nested;
      }
      continue;
    }
    if (!isDeepStrictEqual(liveEntry, templateEntry)) {
      projection[key] = liveEntry;
    }
  }
  return projection;
}

// #3559 lifecycle: the recorded snapshot describes the user's document as it
// was before the first merge. When a reinstall/repair re-merges into a
// config that drifted from the recorded install bytes, the drift is
// user-owned (ECC's installed template keys are stripped via the projection),
// so the snapshot must absorb it — otherwise uninstall restores the stale
// pre-merge document and silently drops the edits made between installs.
// Returns the refreshed snapshot as formatted JSON, or null when no refresh
// applies (recorded write intact, no user edits, or unparsable input — a
// non-object live document is never folded into the snapshot).
function refreshOpenCodeConfigSnapshot(snapshotRawContent, liveRawContent, templateRawContent) {
  const snapshotValue = parseJsonObjectContent(snapshotRawContent);
  const liveValue = parseJsonObjectContent(liveRawContent);
  const templateValue = parseJsonObjectContent(templateRawContent);
  if (snapshotValue === null || liveValue === null || templateValue === null) {
    return null;
  }
  const projection = projectUserOwnedConfigKeys(
    normalizeEmptyPluginKey(liveValue),
    normalizeEmptyPluginKey(templateValue)
  );
  if (Object.keys(projection).length === 0) {
    return null;
  }
  return formatJson(deepMergeJson(snapshotValue, projection));
}

module.exports = {
  isOpenCodeConfigTemplateOperation,
  mergedOpenCodeConfigMatchesDesiredState,
  mergeOpenCodeConfigContent,
  parseJsonObjectContent,
  projectUserOwnedConfigKeys,
  readExistingConfigContent,
  refreshOpenCodeConfigSnapshot,
};
