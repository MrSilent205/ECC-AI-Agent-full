#!/usr/bin/env node
'use strict';

/**
 * Session end marker hook - performs lightweight observer cleanup and
 * outputs stdin to stdout unchanged. Exports run() for in-process execution.
 */

const {
  resolveProjectContext,
  getAliasContexts,
  hasSessionLease,
  removeSessionLease,
  listSessionLeases,
  stopObserverForContext,
  resolveSessionId
} = require('../lib/observer-sessions');
const { resolveHookSessionId } = require('../lib/hook-session');

function log(message) {
  process.stderr.write(`[SessionEnd] ${message}\n`);
}

function releaseLease(observerContext, sessionId) {
  removeSessionLease(observerContext, sessionId);
  const remainingLeases = listSessionLeases(observerContext);

  if (remainingLeases.length === 0) {
    if (stopObserverForContext(observerContext)) {
      log(`Stopped observer for project ${observerContext.projectId} after final session lease ended`);
    } else {
      log(`No running observer to stop for project ${observerContext.projectId}`);
    }
  } else {
    log(`Retained observer for project ${observerContext.projectId}; ${remainingLeases.length} session lease(s) remain`);
  }
}

function run(rawInput) {
  const output = rawInput || '';
  const sessionId = resolveSessionId(resolveHookSessionId(output));

  if (!sessionId) {
    log('No session ID available; skipping observer cleanup');
    return output;
  }

  try {
    const observerContext = resolveProjectContext();
    releaseLease(observerContext, sessionId);
    // If a remote was added mid-session, the SessionStart lease sits under the root's older id.
    for (const aliasContext of getAliasContexts(observerContext)) {
      if (hasSessionLease(aliasContext, sessionId)) releaseLease(aliasContext, sessionId);
    }
  } catch (err) {
    log(`Observer cleanup skipped: ${err.message}`);
  }

  return output;
}

// Legacy CLI execution (when run directly)
if (require.main === module) {
  const MAX_STDIN = 1024 * 1024;
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
    }
  });
  process.stdin.on('end', () => {
    process.stdout.write(run(raw));
  });
}

module.exports = { run };
