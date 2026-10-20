#!/usr/bin/env node
/**
 * SessionEnd hook - ask a working install for feedback, at most twice.
 *
 * Counts completed ECC sessions on disk and, on the milestones in
 * lib/success-feedback.js, prints one short prompt to stderr. It never blocks,
 * never uploads anything, and never reads project files.
 *
 * Delivery contract (Claude Code): this hook runs synchronously on SessionEnd,
 * whose stderr the host shows to the user ("Shows stderr to user only") while
 * discarding JSON output fields. Async delivery would only reach Claude while
 * a session runs, so an async SessionEnd prompt could be silently lost while
 * its milestone was already consumed -- hence synchronous + stderr. The
 * milestone is recorded only once the prompt text is composed and ready to
 * return; a crash before that point stays retry-eligible. Host-side display
 * failures after a clean exit are not observable from here, so the guarantee
 * is at-most-once claims (never duplicate prompts from concurrent sessions),
 * not exactly-once user-visible delivery.
 *
 * Opt out with ECC_NO_FEEDBACK_PROMPT=1.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { getSessionsDir, getSessionSearchDirs } = require('../lib/utils');
const { writeFileAtomic } = require('../lib/atomic-write');
const { emptyState, isOptedOut, recordMilestone, selectMilestone, successFeedbackLines } = require('../lib/success-feedback');

const STATE_FILENAME = '.ecc-success-feedback.json';

// Serialize the read-select-write transition across concurrent SessionEnd
// processes: atomic file replacement alone cannot stop two processes from
// reading the same unprompted milestone and both printing it. The lock is a
// directory (mkdir is atomic on every platform, unlike O_EXCL files on
// Windows network shares) with a stale-expiry so a crashed holder cannot
// silence prompts forever. Failing to lock means another process is claiming
// right now — it will print, so we stay silent.
const LOCK_DIRNAME = `${STATE_FILENAME}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 20;
const LOCK_RETRY_MS = 25;

function lockDirPath() {
  return path.join(getSessionsDir(), LOCK_DIRNAME);
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No monotonic sleep available; fall through and retry immediately.
  }
}

function acquireLock() {
  try {
    if (!fs.existsSync(getSessionsDir())) {
      return false;
    }
  } catch {
    return false;
  }

  const dir = lockDirPath();
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      return true;
    } catch {
      // Already held (or sessions dir vanished mid-loop); maybe steal it.
    }
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
    } catch {
      // Lost a race or the sessions dir is gone; retry or give up below.
    }
    sleepSync(LOCK_RETRY_MS);
  }
  return false;
}

function releaseLock() {
  try {
    fs.rmdirSync(lockDirPath());
  } catch {
    // Best effort: a stale lock expires on its own via LOCK_STALE_MS.
  }
}

// Real session records are written as `*-session.tmp` (see session-manager.js);
// `.tmp` is a historical naming choice, not a transient file. Counting `.md`
// files here would silently count zero sessions forever.
const SESSION_FILE_SUFFIX = '-session.tmp';

function stateFilePath() {
  return path.join(getSessionsDir(), STATE_FILENAME);
}

/**
 * Count completed sessions across the canonical and legacy session
 * directories (see getSessionSearchDirs), so an upgraded or migrated install
 * does not lose credit for sessions run before the upgrade.
 */
function countSessions(sessionsDirs = getSessionSearchDirs()) {
  const dirs = Array.isArray(sessionsDirs) ? sessionsDirs : [sessionsDirs];

  return dirs.reduce((total, dir) => {
    try {
      const count = fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(SESSION_FILE_SUFFIX))
        .length;
      return total + count;
    } catch {
      return total;
    }
  }, 0);
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return emptyState();
  }
}

// Atomic write (temp file + fsync + rename) so a crash or a concurrent
// session can never leave a partially written or corrupt state file.
function writeState(filePath, state) {
  try {
    writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hook entry point. Returns stderr lines only when a milestone is due, and
 * always exits 0 so a feedback prompt can never break a session.
 */
function run() {
  if (isOptedOut()) {
    return { exitCode: 0 };
  }

  if (!acquireLock()) {
    return { exitCode: 0 };
  }
  try {
    const currentState = readState(stateFilePath());
    const milestone = selectMilestone(countSessions(), currentState);
    if (milestone === null) {
      return { exitCode: 0 };
    }

    const lines = successFeedbackLines(milestone);

    // Record only once the prompt is composed and ready to return: a crash
    // before this point stays retry-eligible, and a failed write stays
    // silent (no prompt) so a broken disk cannot cause a repeat-prompt loop.
    if (!writeState(stateFilePath(), recordMilestone(currentState, milestone))) {
      return { exitCode: 0 };
    }

    return { exitCode: 0, stderr: lines.join('\n') };
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  try {
    const result = run();
    if (result.stderr) {
      process.stderr.write(`${result.stderr}\n`);
    }
  } catch {
    // Never fail a session over a feedback prompt.
  }
  process.exit(0);
}

module.exports = { run, countSessions, STATE_FILENAME, LOCK_DIRNAME };
