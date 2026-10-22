/**
 * Shared ECC hook runtime.
 *
 * OpenCode v2-only. This fork is optimized exclusively for OpenCode.
 * For Claude/Codex use the upstream ECC repository.
 *
 * Framework-free on purpose: no `@opencode-ai/plugin` import, so this module
 * loads in any directory without node_modules.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { createRequire } from "node:module"

export type HookProfile = "minimal" | "standard" | "strict"
export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFn = (level: LogLevel, message: string) => void

export type ShellFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown> & { text(): Promise<string> }

export interface ToolArgs {
  filePath?: unknown
  file_path?: unknown
  path?: unknown
  command?: unknown
  [key: string]: unknown
}

export interface PermissionDecision {
  status: "ask" | "allow" | "deny"
  message: string
}

export interface ToolRunners {
  changedFilesDescription: string
  dependencyAnalyzerDescription: string
  executeChangedFiles: (args: any, projectDir: string) => Promise<string>
  executeDependencyAnalyzer: (args: any, projectDir: string) => Promise<string>
}

export interface EccRuntimeOptions {
  /** Project root used to resolve relative paths and detect project markers. */
  projectDir: string
  log: LogFn
  /** Resolve the working directory of a session (falls back to projectDir). */
  resolveSessionDir: (sessionID: string) => Promise<string>
  /** Optional shell runtime (Bun `$`) supplied by the host plugin input. */
  shell?: ShellFn
}

export interface EccRuntime {
  projectDir: string
  currentProfile: HookProfile
  toolBefore(
    toolName: string,
    input: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void>
  toolAfter(
    toolName: string,
    input: unknown,
    output: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void>
  shellEnv(cwd: string | undefined, env: Record<string, string>): void
  permissionDecision(
    action: string,
    resources: string | string[] | undefined | null
  ): PermissionDecision
  compactionText(): string
  onSessionCreated(details: { directory?: string }): void
  onSessionIdle(): Promise<void>
  onSessionDeleted(): void
  onFileChanged(file: string, kind: string): void
  loadToolRunners(): Promise<ToolRunners | undefined>
  dispose(): void
}

const resolvedRuntimeDir = path.dirname(fileURLToPath(import.meta.url))

function normalizeProfile(value: string | undefined): HookProfile {
  if (value === "minimal" || value === "strict") return value
  return "standard"
}

/** Extract a file path from a tool input object, tolerating shape drift. */
function getFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const args = input as ToolArgs
  const p = args.filePath ?? args.file_path ?? args.path
  return typeof p === "string" && p.trim() ? p : null
}

function getCommand(input: unknown): string {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""
  const cmd = (input as ToolArgs).command
  return typeof cmd === "string" ? cmd : ""
}

function countConsoleLogs(filePath: string): number {
  try {
    const text = fs.readFileSync(filePath, "utf-8")
    const matches = text.match(/console\.log\b/g)
    return matches ? matches.length : 0
  } catch {
    return 0
  }
}

/**
 * Artifacts that identify an ECC root, one per capability this plugin needs.
 * Each probe is the exact artifact the caller is about to use, so detection is
 * layout detection rather than an authenticity control.
 */
const ECC_ROOT_PROBES = {
  root: [path.join("scripts", "lib", "utils.js")],
  skillTracker: [path.join("scripts", "hooks", "skill-run-tracker.js")],
  resolver: [path.join("scripts", "lib", "resolve-ecc-root.js")],
} as const

function findEccRootDir(startDir: string, probes: readonly string[]): string | null {
  let current = startDir
  for (let depth = 0; depth < 5; depth += 1) {
    if (probes.every((probe) => fs.existsSync(path.join(current, probe)))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function getECCVersion(eccRootDir?: string | null): string {
  const candidates = [
    eccRootDir,
    path.resolve(resolvedRuntimeDir, ".."),
    path.resolve(resolvedRuntimeDir, "..", ".."),
    path.resolve(resolvedRuntimeDir, "..", "..", ".."),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf-8"))
      if (typeof packageJson.version === "string" && packageJson.version) {
        return packageJson.version
      }
    } catch {
      // Try the next candidate.
    }
  }
  return "2.0.0"
}

let shellProbed = false
let cachedShell: ShellFn | undefined
function getShell(): ShellFn | undefined {
  if (!shellProbed) {
    shellProbed = true
    try {
      const require = createRequire(import.meta.url)
      cachedShell = (require("bun") as { $: ShellFn }).$
    } catch {
      cachedShell = undefined
    }
  }
  return cachedShell
}

function resolvePath(p: string, base: string): string {
  if (path.isAbsolute(p)) return p
  return path.join(base, p)
}

function hasProjectFile(relativePath: string, base: string): boolean {
  try {
    return fs.statSync(resolvePath(relativePath, base)).isFile()
  } catch {
    return false
  }
}

type ChangedFilesStore = typeof import("../lib/changed-files-store.ts")

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
  hookEnabled: (hookId: string, required?: HookProfile | HookProfile[]) => boolean
  editedFiles: Set<string>
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
  changedFilesStore: ChangedFilesStore | undefined
}

/** Shell syntax that can chain, substitute, or redirect past an allowlist. */
const UNSAFE_SHELL_SYNTAX = /[;&|`$<>\n\r(){}]/

const FORMATTER_PATTERN =
  /^(npx )?(@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)(\s+[^\s;&|`$<>(){}\\]+)*$/

const TEST_RUNNER_PATTERN =
  /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)(\s+[-A-Za-z0-9_./=:@,+]+)*$/

function asResourceList(resources: string | string[] | undefined | null): string[] {
  if (Array.isArray(resources)) {
    return resources.map((entry) => String(entry))
  }
  if (typeof resources === "string") return resources === "" ? [] : [resources]
  return []
}

function createPermissionHook(
  log: LogFn
): (action: string, resources: string | string[] | undefined | null) => PermissionDecision {
  return (action, resources) => {
    try {
      if (["read", "glob", "grep", "search", "list"].includes(action)) {
        log("debug", `[ECC] Auto-approved read-only action: ${action}`)
        return { status: "allow", message: "Read-only operation" }
      }

      if (action !== "bash") {
        log("debug", `[ECC] Permission requires user decision: ${action}`)
        return { status: "ask", message: "" }
      }

      const commands = asResourceList(resources).map((entry) => entry.trim())
      // No resource means nothing to validate: never auto-approve.
      if (commands.length === 0 || commands.some((command) => command === "")) {
        log("debug", "[ECC] Bash permission without a command requires user decision")
        return { status: "ask", message: "" }
      }

      // Every resource must independently pass the same allowlist. A single
      // unsafe or unrecognised command keeps the whole request at "ask".
      for (const command of commands) {
        if (UNSAFE_SHELL_SYNTAX.test(command)) {
          log("debug", "[ECC] Bash permission with shell composition requires user decision")
          return { status: "ask", message: "" }
        }
        if (FORMATTER_PATTERN.test(command)) continue
        if (TEST_RUNNER_PATTERN.test(command)) continue
        log("debug", "[ECC] Bash permission command not allowlisted")
        return { status: "ask", message: "" }
      }

      const isTest = commands.every((command) => TEST_RUNNER_PATTERN.test(command))
      log("debug", isTest ? "[ECC] Auto-approved test execution" : "[ECC] Auto-approved formatter")
      return {
        status: "allow",
        message: isTest ? "Test execution" : "Formatter execution",
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("error", `[ECC] Permission handling error for ${action}: ${msg}`)
      return { status: "deny", message: `Error: ${msg}` }
    }
  }
}

function createCompactionHook(
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

function detectPackageManager(base: string, env: Record<string, string>): void {
  const lockfiles: Record<string, string> = {
    "bun.lockb": "bun",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
  }
  for (const [lockfile, pm] of Object.entries(lockfiles)) {
    if (hasProjectFile(lockfile, base)) {
      env.PACKAGE_MANAGER = pm
      return
    }
  }
}

function detectLanguages(base: string, env: Record<string, string>): void {
  const langDetectors: Record<string, string> = {
    "tsconfig.json": "typescript",
    "go.mod": "go",
    "pyproject.toml": "python",
    "Cargo.toml": "rust",
    "Package.swift": "swift",
  }
  const detected: string[] = []
  for (const [file, lang] of Object.entries(langDetectors)) {
    if (hasProjectFile(file, base)) detected.push(lang)
  }
  if (detected.length > 0) {
    env.DETECTED_LANGUAGES = detected.join(",")
    env.PRIMARY_LANGUAGE = detected[0]
  }
}

function createShellEnvHook(
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

function createSessionHooks(context: SessionHookContext): {
  onSessionCreated: (details: { directory?: string }) => void
  onSessionIdle: () => Promise<void>
  onSessionDeleted: () => void
  onFileChanged: (file: string, kind: string) => void
} {
  const {
    projectDir,
    log,
    currentProfile,
    shell,
    hookEnabled,
    editedFiles,
    pendingToolChanges,
    changedFilesStore,
  } = context

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
    if (!file) return
    const changeType = kind === "add" ? "added" : kind === "unlink" ? "deleted" : "modified"
    changedFilesStore?.recordChange(file, changeType)
    if (kind === "change" && file.match(/\.(ts|tsx|js|jsx)$/)) {
      editedFiles.add(file)
    }
  }

  return { onSessionCreated, onSessionIdle, onSessionDeleted, onFileChanged }
}

async function loadToolRunners(log: LogFn): Promise<ToolRunners | undefined> {
  try {
    const changed = await import("../../tools/changed-files.ts")
    const analyzer = await import("../../tools/dependency-analyzer.ts")
    return {
      changedFilesDescription: changed.changedFilesDescription,
      dependencyAnalyzerDescription: analyzer.dependencyAnalyzerDescription,
      executeChangedFiles: (args, dir) => changed.executeChangedFiles(args, dir),
      executeDependencyAnalyzer: (args, dir) => analyzer.executeDependencyAnalyzer(args, dir),
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    log("warn", `[ECC] Custom tools disabled: could not load tool runners. ${msg}`)
    return undefined
  }
}

interface ToolHookContext {
  projectDir: string
  log: LogFn
  shell: ShellFn | undefined
  hookEnabled: (hookId: string, required?: HookProfile | HookProfile[]) => boolean
  editedFiles: Set<string>
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
  changedFilesStore: ChangedFilesStore | undefined
  recordSkillRun: ((payload: unknown) => void) | undefined
  sessionDir: (sessionID: string | undefined) => Promise<string>
}

type HookGate = (hookId: string, required?: HookProfile | HookProfile[]) => boolean

interface FormatterContext {
  log: LogFn
  shell: ShellFn | undefined
}

function createFormatter(context: FormatterContext): {
  runPrettier(filePath: string): Promise<void>
  runTypeCheck(): Promise<void>
} {
  const { log, shell } = context

  async function runPrettier(filePath: string): Promise<void> {
    if (!shell) {
      log("debug", `[ECC] Skipping prettier (no shell runtime): ${filePath}`)
      return
    }
    try {
      await shell`prettier --write ${filePath}`
      log("info", `[ECC] Formatted: ${filePath}`)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("debug", `[ECC] Prettier formatting failed for ${filePath}: ${msg}`)
    }
  }

  async function runTypeCheck(): Promise<void> {
    if (!shell) {
      log("debug", "[ECC] Skipping tsc check (no shell runtime)")
      return
    }
    try {
      await shell`npx tsc --noEmit`
      log("info", "[ECC] TypeScript check passed")
    } catch (error: unknown) {
      log("warn", "[ECC] TypeScript errors detected")
      const stdout = (error as { stdout?: unknown }).stdout
      if (typeof stdout === "string") {
        for (const line of stdout.split("\n").slice(0, 5)) log("warn", `  ${line}`)
      } else {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg) log("warn", `  ${msg.split("\n")[0]}`)
      }
    }
  }

  return { runPrettier, runTypeCheck }
}

async function recordPendingWrite(
  toolName: string,
  input: unknown,
  sessionID: string | undefined,
  callID: string | undefined,
  sessionDir: (sessionID: string | undefined) => Promise<string>,
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
): Promise<void> {
  const filePath = getFilePath(input)
  if (toolName !== "write" || !filePath) return
  const base = await sessionDir(sessionID)
  const absPath = resolvePath(filePath, base)
  let type: "added" | "modified" = "modified"
  try {
    type = fs.existsSync(absPath) ? "modified" : "added"
  } catch {
    type = "modified"
  }
  pendingToolChanges.set(String(callID), { path: filePath, type })
}

function warnPushReminder(
  toolName: string,
  command: string,
  hookEnabled: HookGate,
  log: LogFn
): void {
  if (
    hookEnabled("pre:bash:git-push-reminder", "strict") &&
    toolName === "bash" &&
    command.includes("git push")
  ) {
    log("info", "[ECC] Remember to review changes before pushing: git diff origin/main...HEAD")
  }
}

function warnDocFileWrite(
  toolName: string,
  filePath: string | null,
  hookEnabled: HookGate,
  log: LogFn
): void {
  if (
    hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) &&
    toolName === "write" &&
    typeof filePath === "string" &&
    filePath.match(/\.(md|txt)$/i) &&
    !filePath.includes("README") &&
    !filePath.includes("CHANGELOG") &&
    !filePath.includes("LICENSE") &&
    !filePath.includes("CONTRIBUTING")
  ) {
    log("warn", `[ECC] Creating ${filePath} - consider if this documentation is necessary`)
  }
}

function warnLongCommand(
  toolName: string,
  command: string,
  hookEnabled: HookGate,
  log: LogFn
): void {
  if (hookEnabled("pre:bash:tmux-reminder", "strict") && toolName === "bash") {
    if (
      command.match(/^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/) ||
      command.match(/^cargo\s+(build|test|run)/) ||
      command.match(/^go\s+(build|test|run)/)
    ) {
      log("info", "[ECC] Long-running command detected - consider using background execution")
    }
  }
}

function warnBeforeTool(
  toolName: string,
  filePath: string | null,
  command: string,
  hookEnabled: HookGate,
  log: LogFn
): void {
  warnPushReminder(toolName, command, hookEnabled, log)
  warnDocFileWrite(toolName, filePath, hookEnabled, log)
  warnLongCommand(toolName, command, hookEnabled, log)
}

function recordToolChange(
  toolName: string,
  filePath: string | null,
  callID: string | undefined,
  changedFilesStore: ChangedFilesStore | undefined,
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
): void {
  if (toolName === "edit" && filePath) {
    changedFilesStore?.recordChange(filePath, "modified")
  }
  if (toolName === "write" && filePath) {
    const key = String(callID)
    const pending = pendingToolChanges.get(key)
    if (pending) {
      changedFilesStore?.recordChange(pending.path, pending.type)
      pendingToolChanges.delete(key)
    } else {
      changedFilesStore?.recordChange(filePath, "modified")
    }
  }
}

async function warnAfterEdit(
  toolName: string,
  filePath: string | null,
  projectDir: string,
  hookEnabled: HookGate,
  editedFiles: Set<string>,
  log: LogFn,
  formatter: ReturnType<typeof createFormatter>
): Promise<void> {
  if ((toolName === "edit" || toolName === "write") && filePath) {
    editedFiles.add(filePath)

    if (hookEnabled("post:edit:format", ["strict"]) && filePath.match(/\.(ts|tsx|js|jsx)$/)) {
      await formatter.runPrettier(filePath)
    }

    if (
      hookEnabled("post:edit:console-warn", ["standard", "strict"]) &&
      filePath.match(/\.(ts|tsx|js|jsx)$/)
    ) {
      const count = countConsoleLogs(resolvePath(filePath, projectDir))
      if (count > 0) {
        log("warn", `[ECC] console.log found in ${filePath} (${count} occurrence${count > 1 ? "s" : ""})`)
      }
    }
  }

  if (
    hookEnabled("post:edit:typecheck", ["strict"]) &&
    toolName === "edit" &&
    typeof filePath === "string" &&
    filePath.match(/\.tsx?$/)
  ) {
    await formatter.runTypeCheck()
  }
}

function warnAfterBash(
  toolName: string,
  command: string,
  hookEnabled: HookGate,
  log: LogFn
): void {
  if (
    hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
    toolName === "bash" &&
    command.includes("gh pr create")
  ) {
    log("info", "[ECC] PR created - check GitHub Actions status")
  }
}

function trackSkillRun(
  toolName: string,
  input: unknown,
  output: unknown,
  hookEnabled: HookGate,
  recordSkillRun: ((payload: unknown) => void) | undefined
): void {
  if (
    !hookEnabled("post:skill:track", ["standard", "strict"]) ||
    typeof toolName !== "string" ||
    toolName.trim().toLowerCase() !== "skill"
  ) {
    return
  }
  try {
    recordSkillRun?.({
      tool_name: "Skill",
      tool_input: input ?? {},
      tool_response: output,
    })
  } catch {
    // Telemetry is best-effort; never let it affect the tool result.
  }
}

function createToolHooks(context: ToolHookContext): {
  toolBefore(
    toolName: string,
    input: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void>
  toolAfter(
    toolName: string,
    input: unknown,
    output: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void>
} {
  const {
    projectDir,
    log,
    shell,
    hookEnabled,
    editedFiles,
    pendingToolChanges,
    changedFilesStore,
    recordSkillRun,
    sessionDir,
  } = context
  const formatter = createFormatter({ log, shell })

  async function toolBefore(
    toolName: string,
    input: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void> {
    await recordPendingWrite(toolName, input, sessionID, callID, sessionDir, pendingToolChanges)
    warnBeforeTool(toolName, getFilePath(input), getCommand(input), hookEnabled, log)
  }

  async function toolAfter(
    toolName: string,
    input: unknown,
    output: unknown,
    _sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void> {
    const filePath = getFilePath(input)
    recordToolChange(toolName, filePath, callID, changedFilesStore, pendingToolChanges)
    await warnAfterEdit(toolName, filePath, projectDir, hookEnabled, editedFiles, log, formatter)
    warnAfterBash(toolName, getCommand(input), hookEnabled, log)
    trackSkillRun(toolName, input, output, hookEnabled, recordSkillRun)
  }

  return { toolBefore, toolAfter }
}

function createHookGate(currentProfile: HookProfile): HookGate {
  const disabledHooks = new Set(
    (process.env.ECC_DISABLED_HOOKS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )
  const profileOrder: Record<HookProfile, number> = {
    minimal: 0,
    standard: 1,
    strict: 2,
  }
  return (hookId, required = "standard") => {
    if (disabledHooks.has(hookId)) return false
    const need = Array.isArray(required) ? required : [required]
    return need.some((entry) => profileOrder[currentProfile] >= profileOrder[entry])
  }
}

function createSessionDirResolver(
  projectDir: string,
  sessionDirs: Map<string, string>,
  resolveSessionDir: (sessionID: string) => Promise<string>
): (sessionID: string | undefined) => Promise<string> {
  return async (sessionID) => {
    if (!sessionID) return projectDir
    const cached = sessionDirs.get(sessionID)
    if (cached) return cached
    try {
      const resolved = await resolveSessionDir(sessionID)
      if (resolved) {
        sessionDirs.set(sessionID, resolved)
        return resolved
      }
    } catch {
      // fall through to the plugin location directory
    }
    return projectDir
  }
}

async function loadChangedFilesStore(
  projectDir: string,
  log: LogFn
): Promise<ChangedFilesStore | undefined> {
  try {
    const store = await import("../lib/changed-files-store.ts")
    store.initStore(projectDir)
    return store
  } catch {
    log(
      "warn",
      "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
    )
    return undefined
  }
}

type SkillRunTrackerModule = { run?: (payload: unknown) => void }

async function loadSkillTracker(
  trackerRoot: string | null,
  log: LogFn
): Promise<((payload: unknown) => void) | undefined> {
  try {
    const trackerPath = trackerRoot
      ? path.join(trackerRoot, "scripts", "hooks", "skill-run-tracker.js")
      : null
    if (!trackerPath || !fs.existsSync(trackerPath)) {
      throw new Error("skill-run-tracker.js not found")
    }
    const loaded = (await import(pathToFileURL(trackerPath).href)) as SkillRunTrackerModule & {
      default?: SkillRunTrackerModule
    }
    const entry = typeof loaded.run === "function" ? loaded : loaded.default
    if (!entry || typeof entry.run !== "function") {
      throw new Error("skill-run-tracker.js exposes no run()")
    }
    return entry.run
  } catch {
    log(
      "warn",
      "[ECC] skill-run telemetry disabled: could not load scripts/hooks/skill-run-tracker.js. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
    )
    return undefined
  }
}

function auditConsoleLogs(
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

async function notifyDesktop(shell: ShellFn | undefined, log: LogFn): Promise<void> {
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

function disposeRuntime(
  editedFiles: Set<string>,
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>,
  sessionDirs: Map<string, string>
): void {
  editedFiles.clear()
  pendingToolChanges.clear()
  sessionDirs.clear()
}

export async function createEccRuntime(options: EccRuntimeOptions): Promise<EccRuntime> {
  const { projectDir, log } = options

  const editedFiles = new Set<string>()
  const pendingToolChanges = new Map<string, { path: string; type: "added" | "modified" }>()
  const sessionDirs = new Map<string, string>()

  const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
  const hookEnabled = createHookGate(currentProfile)

  const shell = options.shell ?? getShell()

  const sessionDir = createSessionDirResolver(projectDir, sessionDirs, options.resolveSessionDir)

  // Lazily loaded changed-files store.
  // Lazily loaded changed-files store.
  const changedFilesStore = await loadChangedFilesStore(projectDir, log)

  // Skill telemetry tracker.
  const trackerRoot = findEccRootDir(resolvedRuntimeDir, ECC_ROOT_PROBES.skillTracker)
  const eccRoot =
    findEccRootDir(resolvedRuntimeDir, ECC_ROOT_PROBES.resolver) ??
    findEccRootDir(resolvedRuntimeDir, ECC_ROOT_PROBES.root)
  const recordSkillRun = await loadSkillTracker(trackerRoot, log)

  const { toolBefore, toolAfter } = createToolHooks({
    projectDir,
    log,
    shell,
    hookEnabled,
    editedFiles,
    pendingToolChanges,
    changedFilesStore,
    recordSkillRun,
    sessionDir,
  })

  const shellEnv = createShellEnvHook({ projectDir, currentProfile, eccRoot })

  const permissionDecision = createPermissionHook(log)

  const compactionText = createCompactionHook(editedFiles, eccRoot)

  const { onSessionCreated, onSessionIdle, onSessionDeleted, onFileChanged } = createSessionHooks({
    projectDir,
    log,
    currentProfile,
    shell,
    hookEnabled,
    editedFiles,
    pendingToolChanges,
    changedFilesStore,
  })

  const loadRunners = (): Promise<ToolRunners | undefined> => loadToolRunners(log)


  return {
    projectDir,
    currentProfile,
    toolBefore,
    toolAfter,
    shellEnv,
    permissionDecision,
    compactionText,
    onSessionCreated,
    onSessionIdle,
    onSessionDeleted,
    onFileChanged,
    loadToolRunners: loadRunners,
    dispose: () => disposeRuntime(editedFiles, pendingToolChanges, sessionDirs),
  }
}
