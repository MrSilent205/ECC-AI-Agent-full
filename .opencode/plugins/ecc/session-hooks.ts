/**
 * Session lifecycle and shell environment hooks for the ECC OpenCode runtime.
 */

import type { ChangedFilesStore, HookGate, HookProfile, LogFn, ShellFn } from "./types.ts"
import {
  countConsoleLogs,
  detectLanguages,
  detectPackageManager,
  getECCVersion,
  hasProjectFile,
  resolvePath,
} from "./environment.ts"

interface ShellEnvContext {
  projectDir: string
  currentProfile: HookProfile
  eccRoot: string | null
}

interface SessionHookContext {
  projectDir: string
  log: LogFn
  currentProfile: HookProfile
  shell: ShellFn | undefined
  hookEnabled: HookGate
  editedFiles: Set<string>
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
  changedFilesStore: ChangedFilesStore | undefined
}

export function createCompactionHook(
  editedFiles: Set<string>,
  eccRoot: string | null
): () => string {
  return () => {
    const version = getECCVersion(eccRoot)
    const lines = [
      "# ECC Context (preserve across compaction)",
      "",
      `## Active Plugin: ECC v${version}`, // ## Active Plugin: ECC v2.2.3 (version pinned by getECCVersion)
      "- Hooks: tool.execute.before/after, session lifecycle, shell env, compaction, permission",
      "- Tools: changed-files, dependency-analyzer",
      "- Agents: specialized (planner, architect, tdd-guide, code-reviewer, security-reviewer, build-error-resolver, e2e-runner, refactor-cleaner, doc-updater, go-reviewer, go-build-resolver, database-reviewer, python-reviewer)",
      "",
      "## Key Principles",
      "- TDD: write tests first, 80%+ coverage",
      "- Immutability: never mutate, always return new copies",
      "- Security: validate inputs, no hardcoded secrets",
      "",
      "Focus on preserving: 1) Current task status and progress, 2) Key decisions made, 3) Files created/modified, 4) Remaining work items, 5) Any security concerns flagged. Discard: verbose tool outputs, intermediate exploration, redundant file listings.",
      "",
    ]
    if (editedFiles.size > 0) {
      lines.push("## Recently Edited Files")
      for (const f of editedFiles) lines.push(`- ${f}`)
      lines.push("")
    }
    return lines.join("\n")
  }
}

export function createShellEnvHook(
  context: ShellEnvContext
): (cwd: string | undefined, env: Record<string, string>) => void {
  const { projectDir, currentProfile, eccRoot } = context
  return (cwd, env) => {
    if (!env || typeof env !== "object") return
    const base = cwd || projectDir
    const eccVersion = getECCVersion(eccRoot)
    env.ECC_VERSION = eccVersion
    env.ECC_PLUGIN = "true"
    env.ECC_HOOK_PROFILE = currentProfile
    env.ECC_DISABLED_HOOKS = process.env.ECC_DISABLED_HOOKS || ""
    env.PROJECT_ROOT = base

    detectPackageManager(base, env)
    detectLanguages(base, env)

    // Export CLAUDE_PLUGIN_ROOT so commands can resolve ECC root (V1 preserved).
    const rootAlreadySet = Boolean(
      (process.env.CLAUDE_PLUGIN_ROOT || "").trim() || (env.CLAUDE_PLUGIN_ROOT || "").trim()
    )
    if (eccRoot && !rootAlreadySet) {
      env.CLAUDE_PLUGIN_ROOT = eccRoot
    }
  }
}

export function recordFileChange(
  file: string,
  kind: string,
  store: {
    changedFilesStore: ChangedFilesStore | undefined
    editedFiles: Set<string>
  }
): void {
  if (!file) return
  const changeType = kind === "add" ? "added" : kind === "unlink" ? "deleted" : "modified"
  store.changedFilesStore?.recordChange(file, changeType)
  if (kind === "change" && file.match(/\.(ts|tsx|js|jsx)$/)) {
    store.editedFiles.add(file)
  }
}

export function createSessionHooks(context: SessionHookContext): {
  onSessionCreated: (details: { directory?: string }) => void
  onSessionIdle: () => Promise<void>
  onSessionDeleted: () => void
  onFileChanged: (file: string, kind: string) => void
} {
  const { projectDir, log, currentProfile, shell, hookEnabled, editedFiles } = context
  const { pendingToolChanges, changedFilesStore } = context

  function onSessionCreated(details: { directory?: string }): void {
    if (!hookEnabled("session:start", ["minimal", "standard", "strict"])) return
    log("info", `[ECC] Session started - profile=${currentProfile}`)
    const dir = typeof details.directory === "string" && details.directory ? details.directory : projectDir
    if (hasProjectFile("CLAUDE.md", dir)) {
      log("info", "[ECC] Found CLAUDE.md - loading project context")
    }
  }

  async function onSessionIdle(): Promise<void> {
    if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
    if (editedFiles.size === 0) return
    log("info", "[ECC] Session idle - running console.log audit")
    auditConsoleLogs(editedFiles, projectDir, log)
    await notifyDesktop(shell, log)
    editedFiles.clear()
  }

  function onSessionDeleted(): void {
    if (!hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
    log("info", "[ECC] Session ended - cleaning up")
    editedFiles.clear()
    changedFilesStore?.clearChanges()
    pendingToolChanges.clear()
  }

  function onFileChanged(file: string, kind: string): void {
    recordFileChange(file, kind, { changedFilesStore, editedFiles })
  }

  return { onSessionCreated, onSessionIdle, onSessionDeleted, onFileChanged }
}

export function auditConsoleLogs(
  editedFiles: Set<string>,
  projectDir: string,
  log: LogFn
): void {
  let total = 0
  const filesWithLogs: string[] = []
  for (const file of editedFiles) {
    if (!file.match(/\.(ts|tsx|js|jsx)$/)) continue
    const count = countConsoleLogs(resolvePath(file, projectDir))
    if (count > 0) {
      total += count
      filesWithLogs.push(file)
    }
  }

  if (total > 0) {
    log("warn", `[ECC] Audit: ${total} console.log statement(s) in ${filesWithLogs.length} file(s)`)
    for (const f of filesWithLogs) log("warn", `  - ${f}`)
    log("warn", "[ECC] Remove console.log statements before committing")
  } else {
    log("info", "[ECC] Audit passed: No console.log statements found")
  }
}

export async function notifyDesktop(shell: ShellFn | undefined, log: LogFn): Promise<void> {
  try {
    if (!shell) {
      log("debug", "[ECC] Skipping desktop notification (no shell runtime)")
    } else if (process.platform === "darwin") {
      await shell`osascript -e 'display notification "Task completed!" with title "OpenCode ECC"'`
    } else if (process.platform === "win32") {
      await shell`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')"`
    } else if (process.platform === "linux") {
      await shell`notify-send "OpenCode ECC" "Task completed!"`
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    log("debug", `[ECC] Desktop notification failed: ${msg}`)
  }
}
