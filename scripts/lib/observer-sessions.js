const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ensureDir, sanitizeSessionId } = require('./utils');

function getHomunculusDir() {
  const override = process.env.CLV2_HOMUNCULUS_DIR;
  if (override) {
    if (path.isAbsolute(override)) {
      return override;
    }
    process.stderr.write(`[ecc] CLV2_HOMUNCULUS_DIR=${override} is not absolute; ignoring\n`);
  }

  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) {
    if (path.isAbsolute(xdgDataHome)) {
      return path.join(xdgDataHome, 'ecc-homunculus');
    }
    process.stderr.write(`[ecc] XDG_DATA_HOME=${xdgDataHome} is not absolute; ignoring\n`);
  }

  return path.join(os.homedir(), '.local', 'share', 'ecc-homunculus');
}

function getProjectsDir() {
  return path.join(getHomunculusDir(), 'projects');
}

function getProjectRegistryPath() {
  return path.join(getHomunculusDir(), 'projects.json');
}

function readProjectRegistry() {
  try {
    return JSON.parse(fs.readFileSync(getProjectRegistryPath(), 'utf8'));
  } catch {
    return {};
  }
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) return '';
  return (result.stdout || '').trim();
}

function stripRemoteCredentials(remoteUrl) {
  if (!remoteUrl) return '';
  return String(remoteUrl).replace(/:\/\/[^@]+@/, '://');
}

function normalizeRemoteUrl(remoteUrl) {
  if (!remoteUrl) return '';
  const raw = String(remoteUrl);
  const isNetwork = !raw.startsWith('file://') && (raw.includes('://') || /^[^@/:]+@[^:/]+:/.test(raw));
  let normalized = stripRemoteCredentials(raw)
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/:]+@([^:/]+):/, '$1/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');

  if (isNetwork) {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function resolveProjectRoot(cwd = process.cwd()) {
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && fs.existsSync(envRoot)) {
    return path.resolve(envRoot);
  }

  const gitRoot = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (gitRoot) return path.resolve(gitRoot);

  return '';
}

function getProjectRemoteUrl(projectRoot) {
  return stripRemoteCredentials(runGit(['remote', 'get-url', 'origin'], projectRoot));
}

function computeProjectId(projectRoot) {
  const remoteUrl = getProjectRemoteUrl(projectRoot);
  const hashInput = normalizeRemoteUrl(remoteUrl) || remoteUrl || projectRoot;
  return crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
}

function resolveProjectContext(cwd = process.cwd()) {
  const projectRoot = resolveProjectRoot(cwd);
  if (!projectRoot) {
    const projectDir = getHomunculusDir();
    ensureDir(projectDir);
    return { projectId: 'global', projectRoot: '', projectDir, isGlobal: true };
  }

  const computedId = computeProjectId(projectRoot);
  const currentRemote = getProjectRemoteUrl(projectRoot);
  const registry = readProjectRegistry();
  const matchingEntries = Object.values(registry).filter(
    entry => entry && path.resolve(entry.root || '') === projectRoot
  );

  let projectId;
  const matchingEntry = matchingEntries.find(entry => entry.id === computedId);
  if (matchingEntry) {
    projectId = matchingEntry.id;
  } else if (matchingEntries.length > 0) {
    const hasStaleNoRemoteEntry = currentRemote && matchingEntries.every(entry => !entry.remote);
    if (hasStaleNoRemoteEntry) {
      projectId = computedId;
    } else {
      projectId = matchingEntries[0].id;
    }
  } else {
    projectId = computedId;
  }

  if (matchingEntries.length > 1) {
    const alternate = matchingEntries.find(entry => entry.id !== projectId);
    if (alternate) {
      process.stderr.write(
        `[ecc] Multiple registry entries found for ${projectRoot}; using ${projectId} (merge with: instinct-cli.py projects merge ${alternate.id} ${projectId} --dry-run)\n`
      );
    }
  }

  const projectDir = path.join(getProjectsDir(), projectId);
  ensureDir(projectDir);

  return { projectId, projectRoot, projectDir, isGlobal: false };
}

function getObserverPidFile(context) {
  return path.join(context.projectDir, '.observer.pid');
}

function getObserverSignalCounterFile(context) {
  return path.join(context.projectDir, '.observer-signal-counter');
}

function getObserverActivityFile(context) {
  return path.join(context.projectDir, '.observer-last-activity');
}

function getSessionLeaseDir(context) {
  return path.join(context.projectDir, '.observer-sessions');
}

function resolveSessionId(rawSessionId = process.env.CLAUDE_SESSION_ID) {
  return sanitizeSessionId(rawSessionId || '') || '';
}

function getSessionLeaseFile(context, rawSessionId = process.env.CLAUDE_SESSION_ID) {
  const sessionId = resolveSessionId(rawSessionId);
  if (!sessionId) return '';
  return path.join(getSessionLeaseDir(context), `${sessionId}.json`);
}

function writeSessionLease(context, rawSessionId = process.env.CLAUDE_SESSION_ID, extra = {}) {
  const leaseFile = getSessionLeaseFile(context, rawSessionId);
  if (!leaseFile) return '';

  ensureDir(getSessionLeaseDir(context));
  const payload = {
    sessionId: resolveSessionId(rawSessionId),
    cwd: process.cwd(),
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  fs.writeFileSync(leaseFile, JSON.stringify(payload, null, 2) + '\n');
  return leaseFile;
}

function removeSessionLease(context, rawSessionId = process.env.CLAUDE_SESSION_ID) {
  const leaseFile = getSessionLeaseFile(context, rawSessionId);
  if (!leaseFile) return false;
  try {
    fs.rmSync(leaseFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function listSessionLeases(context) {
  const leaseDir = getSessionLeaseDir(context);
  if (!fs.existsSync(leaseDir)) return [];
  return fs.readdirSync(leaseDir)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(leaseDir, name));
}

function stopObserverForContext(context) {
  const pidFile = getObserverPidFile(context);
  if (!fs.existsSync(pidFile)) return false;

  const pid = (fs.readFileSync(pidFile, 'utf8') || '').trim();
  if (!/^[0-9]+$/.test(pid) || pid === '0' || pid === '1') {
    fs.rmSync(pidFile, { force: true });
    return false;
  }

  try {
    process.kill(Number(pid), 0);
  } catch {
    fs.rmSync(pidFile, { force: true });
    return false;
  }

  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch {
    return false;
  }

  fs.rmSync(pidFile, { force: true });
  fs.rmSync(getObserverSignalCounterFile(context), { force: true });
  return true;
}

module.exports = {
  getHomunculusDir,
  normalizeRemoteUrl,
  computeProjectId,
  resolveProjectContext,
  getObserverActivityFile,
  getObserverPidFile,
  getSessionLeaseDir,
  writeSessionLease,
  removeSessionLease,
  listSessionLeases,
  stopObserverForContext,
  resolveSessionId
};
