/**
 * OpenCode 1.x plugin surface.
 *
 * OpenCode 1.18.29 and newer read `{ id, server }` from a plugin module and call
 * `server(input)` once per session; the returned object is keyed by hook name.
 * This module is that function. It is intentionally free of any v2 import so a
 * v1 install never loads the registry surface.
 *
 * Hook mapping (see the entrypoint for the OpenCode 2 equivalents):
 * - PreToolUse → tool.execute.before
 * - PostToolUse → tool.execute.after
 * - Stop → session.idle
 * - SessionStart → session.created
 * - SessionEnd → session.deleted
 * - shell.env, permission.ask, experimental.session.compacting,
 *   file.watcher.updated and todo.updated are OpenCode-only hook keys.
 *
 * Each hook is a named function over one shared `V1State` so no single function
 * owns the whole contract, and so the v2 surface can mirror the same split.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"
import changedFilesTool from "../../tools/changed-files.ts"
import dependencyAnalyzerTool from "../../tools/dependency-analyzer.ts"
import {
  ECC_ROOT_PROBES,
  PLUGIN_DIR,
  classifySafeCommand,
  createHookGate,
  errorMessage,
  findEccRootDir,
  getECCVersion,
  loadChangedFilesStore,
  loadSkillRunTracker,
  type ChangedFilesStore,
  type HookGate,
} from "./hooks-shared.ts"

interface ToolArgs {
  filePath?: string
  file_path?: string
  path?: string
  command?: string
  [key: string]: unknown
}

interface ToolInput {
  tool: string
  callID?: string
  args?: ToolArgs
}

interface PermissionEvent {
  tool: string
  args: unknown
}

type V1LogLevel = "debug" | "info" | "warn" | "error"
type V1Log = (level: V1LogLevel, message: string) => Promise<unknown>
type V1Shell = PluginInput["$"]

/** Everything the hook implementations share for one session. */
interface V1State extends HookGate {
  log: V1Log
  shell: V1Shell
  worktreePath: string
  editedFiles: Set<string>
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
  changedFilesStore?: ChangedFilesStore
  recordSkillRun?: (payload: unknown) => void
  eccRoot: string | null
  resolvePath: (p: string) => string
  hasProjectFile: (relativePath: string) => boolean
  writeKey: (filePath: string) => string
}

type ECCHooksPluginFn = (input: PluginInput) => Promise<Record<string, unknown>>

const SCRIPT_FILE = /\.(ts|tsx|js|jsx)$/

function getFilePath(args: ToolArgs | undefined): string | null {
  if (!args) return null
  const p = (args.filePath ?? args.file_path ?? args.path) as string | undefined
  return typeof p === "string" && p.trim() ? p : null
}

/**
 * Report a disabled optional capability without letting the report itself escape.
 *
 * Deferred via .then() rather than `Promise.resolve(log(...))` so that even a
 * *synchronous* throw inside log() stays caught. The raw loader error is
 * deliberately not included: it can contain absolute filesystem paths, and this
 * path exists to guarantee startup resilience when things go wrong.
 */
function warnDisabled(log: V1Log, message: string): void {
  Promise.resolve()
    .then(() => log("warn", message))
    .catch(() => {})
}

/**
 * Load and initialize the changed-files store, or disable that capability.
 *
 * The store is loaded lazily rather than through a top-level import so that a
 * missing or partially-installed `plugins/lib` directory (e.g. an interrupted
 * install on Termux/Android) only disables change tracking. This file is
 * OpenCode's startup entry point, so a static import failure here previously
 * crashed the whole plugin — and with it the session — before any hook could
 * load (see #2530).
 */
async function loadStoreSafely(log: V1Log, worktreePath: string): Promise<ChangedFilesStore | undefined> {
  try {
    const store = await loadChangedFilesStore()
    store?.initStore?.(worktreePath)
    return store
  } catch {
    warnDisabled(
      log,
      "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
    )
    return undefined
  }
}

/**
 * Load the skill-run tracker, or disable that capability.
 *
 * Claude Code routes post:skill:track through
 * scripts/hooks/posttooluse-dispatcher.js, which OpenCode never invokes. Without
 * a caller here, nothing ever writes skill-runs.jsonl and
 * `skills-health.js --dashboard` has no data to report on any skill (#2463). The
 * tracker module is reused rather than reimplemented so its identifier
 * validation, length bounds and "never persist prompt text" guarantees stay the
 * ones written and audited for the Claude Code path.
 */
async function loadTrackerSafely(log: V1Log): Promise<((payload: unknown) => void) | undefined> {
  try {
    return await loadSkillRunTracker()
  } catch {
    warnDisabled(
      log,
      "[ECC] skill-run telemetry disabled: could not load scripts/hooks/skill-run-tracker.js. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
    )
    return undefined
  }
}

/** Resolve the session state, including the two optional modules. */
async function createState(input: PluginInput): Promise<V1State> {
  const worktreePath = input.worktree || input.directory
  const log: V1Log = (level, message) =>
    input.client.app.log({ body: { service: "ecc", level, message } })
  const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.join(worktreePath, p))
  const hasProjectFile = (relativePath: string): boolean => {
    try {
      return fs.statSync(resolvePath(relativePath)).isFile()
    } catch {
      return false
    }
  }
  let writeCounter = 0

  const changedFilesStore = await loadStoreSafely(log, worktreePath)
  const recordSkillRun = await loadTrackerSafely(log)

  return {
    ...createHookGate(),
    log,
    shell: input.$,
    worktreePath,
    editedFiles: new Set<string>(),
    pendingToolChanges: new Map<string, { path: string; type: "added" | "modified" }>(),
    changedFilesStore,
    recordSkillRun,
    // The root advertised to commands requires the resolver, so a root without
    // it would break them again.
    eccRoot: findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.resolver) ?? findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.root),
    resolvePath,
    hasProjectFile,
    writeKey: (filePath: string) => `write-${++writeCounter}-${filePath}`,
  }
}

/* ------------------------------------------------------------------------- *
 * PostToolUse
 * ------------------------------------------------------------------------- */

/**
 * Prettier auto-format and console.log warning for an edited file.
 *
 * Equivalent to the Claude Code PostToolUse hooks; formatting is strict-only and
 * the console.log warning runs at standard and above.
 */
async function onFileEdited(event: { path: string }, state: V1State): Promise<void> {
  state.editedFiles.add(event.path)
  state.changedFilesStore?.recordChange?.(event.path, "modified")

  if (!SCRIPT_FILE.test(event.path)) return

  if (state.hookEnabled("post:edit:format", ["strict"])) {
    try {
      await state.shell`prettier --write ${event.path} 2>/dev/null`
      void state.log("info", `[ECC] Formatted: ${event.path}`)
    } catch (error: unknown) {
      // Prettier not installed or failed - log but continue
      void state.log("debug", `[ECC] Prettier formatting failed for ${event.path}: ${errorMessage(error)}`)
    }
  }

  if (state.hookEnabled("post:edit:console-warn", ["standard", "strict"])) {
    try {
      const result = await state.shell`grep -n "console\\.log" ${event.path} 2>/dev/null`.text()
      if (result.trim()) {
        const lines = result.trim().split("\n").length
        void state.log(
          "warn",
          `[ECC] console.log found in ${event.path} (${lines} occurrence${lines > 1 ? "s" : ""})`
        )
      }
    } catch {
      // No console.log found (grep returns non-zero) - this is good
    }
  }
}

/** Record the change a completed write/edit tool call produced. */
function recordToolChange(
  input: ToolInput,
  state: V1State,
  filePath: string | null
): void {
  if (!filePath) return
  if (input.tool === "edit") {
    state.changedFilesStore?.recordChange?.(filePath, "modified")
    return
  }
  if (input.tool !== "write") return

  const key = input.callID ?? state.writeKey(filePath)
  const pending = state.pendingToolChanges.get(key)
  if (pending) {
    state.changedFilesStore?.recordChange?.(pending.path, pending.type)
    state.pendingToolChanges.delete(key)
  } else {
    state.changedFilesStore?.recordChange?.(filePath, "modified")
  }
}

/** `tsc --noEmit` after an edit to a TypeScript file. */
async function runTypecheck(input: ToolInput, state: V1State): Promise<void> {
  if (!state.hookEnabled("post:edit:typecheck", ["strict"])) return
  if (input.tool !== "edit" || !input.args?.filePath?.match(/\.tsx?$/)) return

  try {
    await state.shell`npx tsc --noEmit 2>&1`
    void state.log("info", "[ECC] TypeScript check passed")
  } catch (error: unknown) {
    const err = error as { stdout?: string }
    void state.log("warn", "[ECC] TypeScript errors detected:")
    if (err.stdout) {
      // Log first few errors
      const errors = err.stdout.split("\n").slice(0, 5)
      errors.forEach((line: string) => void state.log("warn", `  ${line}`))
    }
  }
}

/** OpenCode's tool is named `skill`, so the harness-side name is matched here. */
function trackSkillRun(input: ToolInput, output: unknown, state: V1State): void {
  if (!state.hookEnabled("post:skill:track", ["standard", "strict"])) return
  if (typeof input.tool !== "string" || input.tool.trim().toLowerCase() !== "skill") return
  try {
    state.recordSkillRun?.({
      tool_name: "Skill",
      tool_input: input.args ?? {},
      tool_response: output,
    })
  } catch {
    // Telemetry is best-effort; never let it affect the tool result.
  }
}

async function onToolExecuteAfter(input: ToolInput, output: unknown, state: V1State): Promise<void> {
  recordToolChange(input, state, getFilePath(input.args))

  await runTypecheck(input, state)

  if (
    state.hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
    input.tool === "bash" &&
    input.args?.toString().includes("gh pr create")
  ) {
    void state.log("info", "[ECC] PR created - check GitHub Actions status")
  }

  trackSkillRun(input, output, state)
}

/* ------------------------------------------------------------------------- *
 * PreToolUse
 * ------------------------------------------------------------------------- */

/** Remember whether the upcoming write creates or modifies the file. */
function trackPendingWrite(input: ToolInput, state: V1State): void {
  if (input.tool !== "write") return
  const filePath = getFilePath(input.args)
  if (!filePath) return

  const absPath = state.resolvePath(filePath)
  let type: "added" | "modified" = "modified"
  try {
    if (typeof fs.existsSync === "function") {
      type = fs.existsSync(absPath) ? "modified" : "added"
    }
  } catch {
    type = "modified"
  }
  const key = input.callID ?? state.writeKey(filePath)
  state.pendingToolChanges.set(key, { path: filePath, type })
}

async function onToolExecuteBefore(input: ToolInput, state: V1State): Promise<void> {
  trackPendingWrite(input, state)

  // Git push review reminder
  if (
    state.hookEnabled("pre:bash:git-push-reminder", "strict") &&
    input.tool === "bash" &&
    input.args?.toString().includes("git push")
  ) {
    void state.log("info", "[ECC] Remember to review changes before pushing: git diff origin/main...HEAD")
  }

  // Block creation of unnecessary documentation files
  if (state.hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) && input.tool === "write") {
    const filePath = input.args?.filePath
    if (
      typeof filePath === "string" &&
      filePath.match(/\.(md|txt)$/i) &&
      !filePath.includes("README") &&
      !filePath.includes("CHANGELOG") &&
      !filePath.includes("LICENSE") &&
      !filePath.includes("CONTRIBUTING")
    ) {
      void state.log("warn", `[ECC] Creating ${filePath} - consider if this documentation is necessary`)
    }
  }

  // Long-running command reminder
  if (state.hookEnabled("pre:bash:tmux-reminder", "strict") && input.tool === "bash") {
    const cmd = String(input.args?.command || input.args || "")
    if (
      cmd.match(/^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/) ||
      cmd.match(/^cargo\s+(build|test|run)/) ||
      cmd.match(/^go\s+(build|test|run)/)
    ) {
      void state.log("info", "[ECC] Long-running command detected - consider using background execution")
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Session lifecycle
 * ------------------------------------------------------------------------- */

/** Equivalent to the Claude Code SessionStart hook. */
function onSessionCreated(state: V1State): void {
  if (!state.hookEnabled("session:start", ["minimal", "standard", "strict"])) return

  void state.log("info", `[ECC] Session started - profile=${state.currentProfile}`)

  if (state.hasProjectFile("CLAUDE.md")) {
    void state.log("info", "[ECC] Found CLAUDE.md - loading project context")
  }
}

/** Desktop notification, best-effort and platform-specific. */
async function notifyDesktop(state: V1State): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await state.shell`osascript -e 'display notification "Task completed!" with title "OpenCode ECC"' 2>/dev/null`
    } else if (process.platform === "win32") {
      await state.shell`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')" 2>/dev/null`
    } else if (process.platform === "linux") {
      await state.shell`notify-send "OpenCode ECC" "Task completed!" 2>/dev/null`
    }
  } catch (error: unknown) {
    // Notification not supported or failed - log but continue
    void state.log("debug", `[ECC] Desktop notification failed: ${errorMessage(error)}`)
  }
}

/**
 * Equivalent to the Claude Code Stop hook: audit every edited file for
 * console.log, then notify and reset the edit set.
 */
async function onSessionIdle(state: V1State): Promise<void> {
  if (!state.hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
  if (state.editedFiles.size === 0) return

  void state.log("info", "[ECC] Session idle - running console.log audit")

  let totalConsoleLogCount = 0
  const filesWithConsoleLogs: string[] = []

  for (const file of state.editedFiles) {
    if (!SCRIPT_FILE.test(file)) continue

    try {
      const result = await state.shell`grep -c "console\\.log" ${file} 2>/dev/null`.text()
      const count = parseInt(result.trim(), 10)
      if (count > 0) {
        totalConsoleLogCount += count
        filesWithConsoleLogs.push(file)
      }
    } catch {
      // No console.log found
    }
  }

  if (totalConsoleLogCount > 0) {
    void state.log(
      "warn",
      `[ECC] Audit: ${totalConsoleLogCount} console.log statement(s) in ${filesWithConsoleLogs.length} file(s)`
    )
    filesWithConsoleLogs.forEach((f) => void state.log("warn", `  - ${f}`))
    void state.log("warn", "[ECC] Remove console.log statements before committing")
  } else {
    void state.log("info", "[ECC] Audit passed: No console.log statements found")
  }

  await notifyDesktop(state)

  // Clear tracked files for next task
  state.editedFiles.clear()
}

/** Equivalent to the Claude Code SessionEnd hook. */
function onSessionDeleted(state: V1State): void {
  if (!state.hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
  void state.log("info", "[ECC] Session ended - cleaning up")
  state.editedFiles.clear()
  state.changedFilesStore?.clearChanges?.()
  state.pendingToolChanges.clear()
}

/* ------------------------------------------------------------------------- *
 * OpenCode-only hooks
 * ------------------------------------------------------------------------- */

function onFileWatcherUpdated(event: { path: string; type: string }, state: V1State): void {
  let changeType: "added" | "modified" | "deleted" = "modified"
  if (event.type === "create" || event.type === "add") changeType = "added"
  else if (event.type === "delete" || event.type === "remove") changeType = "deleted"
  state.changedFilesStore?.recordChange?.(event.path, changeType)
  if (event.type === "change" && SCRIPT_FILE.test(event.path)) {
    state.editedFiles.add(event.path)
  }
}

function onTodoUpdated(event: { todos: Array<{ text: string; done: boolean }> }, state: V1State): void {
  const completed = event.todos.filter((t) => t.done).length
  const total = event.todos.length
  if (total > 0) {
    void state.log("info", `[ECC] Progress: ${completed}/${total} tasks completed`)
  }
}

function detectPackageManager(state: V1State): string | undefined {
  const lockfiles: Record<string, string> = {
    "bun.lockb": "bun",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
  }
  for (const [lockfile, manager] of Object.entries(lockfiles)) {
    if (state.hasProjectFile(lockfile)) return manager
  }
  return undefined
}

function detectLanguages(state: V1State): string[] {
  const langDetectors: Record<string, string> = {
    "tsconfig.json": "typescript",
    "go.mod": "go",
    "pyproject.toml": "python",
    "Cargo.toml": "rust",
    "Package.swift": "swift",
  }
  return Object.entries(langDetectors)
    .filter(([file]) => state.hasProjectFile(file))
    .map(([, language]) => language)
}

/**
 * Inject ECC's environment into a shell command.
 *
 * Triggers: Before shell command execution.
 * Sets PROJECT_ROOT, PACKAGE_MANAGER, DETECTED_LANGUAGES, ECC_VERSION.
 */
function onShellEnv(
  _input: { cwd: string },
  output: { env: Record<string, string> },
  state: V1State
): void {
  const env: Record<string, string> = {
    ECC_VERSION: getECCVersion(state.eccRoot),
    ECC_PLUGIN: "true",
    ECC_HOOK_PROFILE: state.currentProfile,
    ECC_DISABLED_HOOKS: process.env.ECC_DISABLED_HOOKS || "",
    PROJECT_ROOT: state.worktreePath,
  }

  const packageManager = detectPackageManager(state)
  if (packageManager) env.PACKAGE_MANAGER = packageManager

  const languages = detectLanguages(state)
  if (languages.length > 0) {
    env.DETECTED_LANGUAGES = languages.join(",")
    env.PRIMARY_LANGUAGE = languages[0]
  }

  // resolve-ecc-root.js only probes ~/.claude and Claude Code's plugin cache, so
  // under OpenCode it fell back to ~/.claude and every command carrying the
  // inlined resolver failed to find its scripts. That resolver reads
  // CLAUDE_PLUGIN_ROOT first, so exporting the root here fixes them through
  // the mechanism ECC already provides -- rather than editing the command files
  // that embed the locator.
  //
  // Only set when a root actually exists, and never replace a root someone else
  // already chose: neither the process environment (set by the user) nor
  // `output.env` (set by an earlier plugin). The final merge below overwrites
  // output.env, so checking it only in `env` would clobber it.
  const rootAlreadySet = Boolean(
    (process.env.CLAUDE_PLUGIN_ROOT || "").trim() || (output.env?.CLAUDE_PLUGIN_ROOT || "").trim()
  )
  if (state.eccRoot && !rootAlreadySet) {
    env.CLAUDE_PLUGIN_ROOT = state.eccRoot
  }

  // OpenCode reads the supplied output object and ignores callback return values.
  output.env = { ...output.env, ...env }
}

function buildCompactionContext(state: V1State): string[] {
  const contextBlock = [
    "# ECC Context (preserve across compaction)",
    "",
    `## Active Plugin: ECC v${getECCVersion(state.eccRoot)}`,
    "- Hooks: file.edited, tool.execute.before/after, session.created/idle/deleted, shell.env, compacting, permission.ask",
    "- Tools: changed-files, dependency-analyzer (registered by this plugin on the OpenCode 1 contract)",
    "- Agents: 13 specialized (planner, architect, tdd-guide, code-reviewer, security-reviewer, build-error-resolver, e2e-runner, refactor-cleaner, doc-updater, go-reviewer, go-build-resolver, database-reviewer, python-reviewer)",
    "",
    "## Key Principles",
    "- TDD: write tests first, 80%+ coverage",
    "- Immutability: never mutate, always return new copies",
    "- Security: validate inputs, no hardcoded secrets",
    "",
  ]

  if (state.editedFiles.size > 0) {
    contextBlock.push("## Recently Edited Files")
    for (const f of state.editedFiles) {
      contextBlock.push(`- ${f}`)
    }
    contextBlock.push("")
  }

  return [
    contextBlock.join("\n"),
    "Focus on preserving: 1) Current task status and progress, 2) Key decisions made, 3) Files created/modified, 4) Remaining work items, 5) Any security concerns flagged. Discard: verbose tool outputs, intermediate exploration, redundant file listings.",
  ]
}

/**
 * Control context compaction behavior.
 *
 * OpenCode requires output assignment and skips `context` when a prompt is set.
 */
function onCompaction(
  _input: { sessionID: string },
  output: { context: string[]; prompt?: string },
  state: V1State
): void {
  const eccContext = buildCompactionContext(state)

  if (output.prompt !== undefined) {
    output.prompt = [output.prompt, ...eccContext].join("\n\n")
  } else {
    output.context = [...output.context, ...eccContext]
  }
}

function commandOfPermissionEvent(args: unknown): string {
  if (typeof args === "string") return args
  if (args && typeof args === "object") {
    return String((args as Record<string, unknown>).command || "")
  }
  return String(args || "")
}

/**
 * Auto-approve safe operations.
 *
 * Reads/search and a single formatter or test command are approved; everything
 * else falls through to the user. Compound commands (`npm test && curl … | sh`)
 * are classified as unsafe, so a prefix can never approve the rest of the line.
 */
async function onPermissionAsk(
  event: PermissionEvent,
  state: V1State
): Promise<{ approved?: boolean; reason?: string }> {
  void state.log("info", `[ECC] Permission requested for: ${event.tool}`)

  try {
    const cmd = commandOfPermissionEvent(event.args)

    if (["read", "glob", "grep", "search", "list"].includes(event.tool)) {
      void state.log("debug", `[ECC] Auto-approved read-only tool: ${event.tool}`)
      return { approved: true, reason: "Read-only operation" }
    }

    const kind = classifySafeCommand(cmd)
    if (event.tool === "bash" && kind === "formatter") {
      void state.log("debug", `[ECC] Auto-approved formatter: ${cmd}`)
      return { approved: true, reason: "Formatter execution" }
    }

    if (event.tool === "bash" && kind === "test") {
      void state.log("debug", `[ECC] Auto-approved test execution: ${cmd}`)
      return { approved: true, reason: "Test execution" }
    }

    // Everything else: let user decide
    void state.log("debug", `[ECC] Permission requires user approval: ${event.tool}`)
    return { approved: undefined }
  } catch (error: unknown) {
    // Error in permission handling - log and deny for safety
    void state.log("error", `[ECC] Permission handling error for ${event.tool}: ${errorMessage(error)}`)
    return { approved: false, reason: `Error: ${errorMessage(error)}` }
  }
}

/* ------------------------------------------------------------------------- *
 * Entrypoint
 * ------------------------------------------------------------------------- */

export const ECCHooksPlugin: ECCHooksPluginFn = async (input: PluginInput) => {
  const state = await createState(input)

  return {
    "file.edited": (event: { path: string }) => onFileEdited(event, state),
    "tool.execute.after": (toolInput: ToolInput, output: unknown) =>
      onToolExecuteAfter(toolInput, output, state),
    "tool.execute.before": (toolInput: ToolInput) => onToolExecuteBefore(toolInput, state),
    "session.created": () => onSessionCreated(state),
    "session.idle": () => onSessionIdle(state),
    "session.deleted": () => onSessionDeleted(state),
    "file.watcher.updated": (event: { path: string; type: string }) => onFileWatcherUpdated(event, state),
    "todo.updated": (event: { todos: Array<{ text: string; done: boolean }> }) => onTodoUpdated(event, state),
    "shell.env": (shellInput: { cwd: string }, output: { env: Record<string, string> }) =>
      onShellEnv(shellInput, output, state),
    "experimental.session.compacting": (
      compactionInput: { sessionID: string },
      output: { context: string[]; prompt?: string }
    ) => onCompaction(compactionInput, output, state),
    "permission.ask": (event: PermissionEvent) => onPermissionAsk(event, state),

    tool: {
      "changed-files": changedFilesTool,
      "dependency-analyzer": dependencyAnalyzerTool,
    },
  }
}
