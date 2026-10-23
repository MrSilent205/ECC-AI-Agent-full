/**
 * OpenCode 2.x plugin surface.
 *
 * OpenCode 2 replaced the v1 `(input) => Hooks` plugin function with a default
 * export of `{ id, setup(ctx) }` and a registry-style context. Hook names moved
 * from object keys to domain registrations, and several v1 events became
 * subscriptions on the public event stream:
 *
 * - shell.env                   → ctx.shell.hook("create.before")
 * - tool.execute.before/after   → ctx.tool.hook("execute.before"/"execute.after")
 * - permission.ask              → ctx.permission.hook("evaluate")
 * - experimental.session.compacting → ctx.session.hook("compaction")
 * - session.* / file.edited     → ctx.event.subscribe()
 * - file.watcher.updated        → event "filesystem.changed"
 * - todo.updated                → no OpenCode 2 equivalent (dropped)
 *
 * `setup` must never throw: OpenCode marks the whole plugin as failed when it
 * does, which would take the v1 side of the module down with it. Every
 * registration is isolated for that reason, and each surface lives in its own
 * small registrar so no single function owns the whole contract.
 */

import * as fs from "fs"
import * as path from "path"
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
  logV2,
  notifyCompletion,
  readText,
  runCommand,
  type ChangedFilesStore,
  type HookGate,
} from "./hooks-shared.ts"

interface V2HookRegistration {
  dispose?: () => void | Promise<void>
}

interface V2ShellCreateBefore {
  command?: string
  cwd?: string
  timeout?: number
  shell?: string
  env?: Record<string, string | undefined>
}

interface V2ToolEvent {
  tool?: string
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
  callID?: string
  input?: unknown
  args?: unknown
  status?: string
  result?: unknown
  error?: unknown
}

interface V2PermissionEvaluation {
  sessionID?: string
  agent?: string
  action?: string
  resources?: readonly string[] | string
  metadata?: Record<string, unknown>
  effect?: "allow" | "ask" | "deny"
  message?: string
}

interface V2SystemPart {
  type: string
  text?: string
  [key: string]: unknown
}

interface V2CompactionEvent {
  messages?: readonly unknown[]
  system?: V2SystemPart[]
  // Present only when a v1-shaped caller invokes the hook; OpenCode 2 passes
  // `system` instead.
  context?: string[]
  options?: Record<string, unknown>
  result?: unknown
}

interface V2Event {
  type?: string
  file?: unknown
  event?: unknown
  data?: { file?: unknown; event?: unknown; [key: string]: unknown }
  [key: string]: unknown
}

export interface V2PluginContext {
  app?: { version?: string }
  location?: { directory?: string; project?: { directory?: string } }
  worktree?: string
  directory?: string
  shell?: {
    hook?: (
      name: "create.before",
      callback: (event: V2ShellCreateBefore) => void | Promise<void>
    ) => Promise<V2HookRegistration>
  }
  tool?: {
    hook?: (
      name: "execute.before" | "execute.after",
      callback: (event: V2ToolEvent) => void | Promise<void>
    ) => Promise<V2HookRegistration>
  }
  permission?: {
    hook?: (
      name: "evaluate",
      callback: (event: V2PermissionEvaluation) => void | Promise<void>
    ) => Promise<V2HookRegistration>
  }
  session?: {
    hook?: (
      name: "compaction",
      callback: (event: V2CompactionEvent) => void | Promise<void>
    ) => Promise<V2HookRegistration>
  }
  event?: {
    subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<V2Event>
  }
}

/** Per-session state shared by the registrars below. */
interface V2State extends HookGate {
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

const SCRIPT_FILE = /\.(ts|tsx|js|jsx)$/
const READ_ONLY_ACTIONS = new Set(["read", "glob", "grep", "list", "search", "todowrite", "todoread"])

function worktreeOf(ctx: V2PluginContext): string {
  return (
    ctx?.location?.directory ||
    ctx?.location?.project?.directory ||
    ctx?.worktree ||
    ctx?.directory ||
    process.cwd()
  )
}

async function loadStore(worktreePath: string): Promise<ChangedFilesStore | undefined> {
  try {
    const store = await loadChangedFilesStore()
    store?.initStore?.(worktreePath)
    return store
  } catch (error: unknown) {
    logV2(
      "warn",
      "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected. " +
        `(${errorMessage(error)})`
    )
    return undefined
  }
}

async function loadTracker(): Promise<((payload: unknown) => void) | undefined> {
  try {
    return await loadSkillRunTracker()
  } catch {
    logV2(
      "warn",
      "[ECC] skill-run telemetry disabled: could not load scripts/hooks/skill-run-tracker.js. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
    )
    return undefined
  }
}

async function createState(ctx: V2PluginContext): Promise<V2State> {
  const worktreePath = worktreeOf(ctx)
  const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.join(worktreePath, p))
  const hasProjectFile = (relativePath: string): boolean => {
    try {
      return fs.statSync(resolvePath(relativePath)).isFile()
    } catch {
      return false
    }
  }
  let writeCounter = 0

  return {
    ...createHookGate(),
    worktreePath,
    editedFiles: new Set<string>(),
    pendingToolChanges: new Map<string, { path: string; type: "added" | "modified" }>(),
    changedFilesStore: await loadStore(worktreePath),
    recordSkillRun: await loadTracker(),
    eccRoot:
      findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.resolver) ?? findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.root),
    resolvePath,
    hasProjectFile,
    writeKey: (filePath: string) => `write-${++writeCounter}-${filePath}`,
  }
}

/* ------------------------------------------------------------------------- *
 * Registration plumbing
 * ------------------------------------------------------------------------- */

/**
 * Run one registration and keep its handle.
 *
 * The handle is what lets cleanup unregister the hook, so discarding it (as an
 * earlier version did) left every callback live after the plugin was disposed.
 * A failed registration is a warning, not a setup failure: the rest of the
 * surface still works.
 */
async function safeRegister(
  label: string,
  thunk: () => Promise<V2HookRegistration>,
  registrations: V2HookRegistration[]
): Promise<void> {
  try {
    const registration = await thunk()
    if (registration && typeof registration.dispose === "function") {
      registrations.push(registration)
    }
  } catch (error: unknown) {
    logV2("warn", `[ECC] could not register ${label}: ${errorMessage(error)}`)
  }
}

/* ------------------------------------------------------------------------- *
 * shell.env
 * ------------------------------------------------------------------------- */

async function registerShellEnv(
  ctx: V2PluginContext,
  state: V2State,
  registrations: V2HookRegistration[]
): Promise<void> {
  const shell = ctx?.shell
  if (!shell?.hook) return
  const register = shell.hook
  await safeRegister("shell.hook(create.before)", () =>
    register.call(shell, "create.before", (event) => {
      try {
        if (!event) return
        if (!event.env || typeof event.env !== "object") event.env = {}
        Object.assign(event.env, projectEnv(state, event.env))
      } catch (error: unknown) {
        logV2("warn", `[ECC] shell env hook failed: ${errorMessage(error)}`)
      }
    }),
    registrations
  )
}

function detectPackageManager(state: V2State): string | undefined {
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

function detectLanguages(state: V2State): string[] {
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
 * Build the environment block for a shell command.
 *
 * `existing` is the environment an earlier plugin already contributed, so a
 * root it chose is never replaced — the same contract as v1's `shell.env`.
 */
function projectEnv(
  state: V2State,
  existing: Record<string, string | undefined>
): Record<string, string> {
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

  // Commands carry an inlined resolver that reads CLAUDE_PLUGIN_ROOT first, so
  // exporting the ECC root here fixes them through ECC's own mechanism. Only
  // set it when a root exists and nobody else chose one.
  const rootAlreadySet = Boolean(
    (process.env.CLAUDE_PLUGIN_ROOT || "").trim() || (existing.CLAUDE_PLUGIN_ROOT || "").trim()
  )
  if (state.eccRoot && !rootAlreadySet) env.CLAUDE_PLUGIN_ROOT = state.eccRoot

  return env
}

/* ------------------------------------------------------------------------- *
 * tool.execute.before / tool.execute.after
 * ------------------------------------------------------------------------- */

async function registerToolHooks(
  ctx: V2PluginContext,
  state: V2State,
  registrations: V2HookRegistration[]
): Promise<void> {
  const tool = ctx?.tool
  if (!tool?.hook) return
  const register = tool.hook

  await safeRegister("tool.hook(execute.before)", () =>
    register.call(tool, "execute.before", (event) => {
      try {
        handleToolBefore(event, state)
      } catch (error: unknown) {
        logV2("warn", `[ECC] execute.before hook failed: ${errorMessage(error)}`)
      }
    }),
    registrations
  )

  await safeRegister("tool.hook(execute.after)", () =>
    register.call(tool, "execute.after", async (event) => {
      try {
        await handleToolAfter(event, state)
      } catch (error: unknown) {
        logV2("warn", `[ECC] execute.after hook failed: ${errorMessage(error)}`)
      }
    }),
    registrations
  )
}

function handleToolBefore(event: V2ToolEvent | undefined, state: V2State): void {
  const name = toolNameOf(event)
  const args = toolArgsOf(event)
  const filePath = filePathOf(args)

  trackPendingWrite(event, state, name, filePath)
  warnGitPush(name, args, state)
  warnDocFile(name, filePath, state)
  warnLongRunning(name, args, state)
}

function trackPendingWrite(
  event: V2ToolEvent | undefined,
  state: V2State,
  name: string,
  filePath: string | null
): void {
  if (name !== "write" || !filePath) return
  const key = event?.id ?? event?.callID ?? state.writeKey(filePath)
  state.pendingToolChanges.set(key, {
    path: filePath,
    type: fs.existsSync(state.resolvePath(filePath)) ? "modified" : "added",
  })
}

function warnGitPush(name: string, args: Record<string, unknown>, state: V2State): void {
  if (!state.hookEnabled("pre:bash:git-push-reminder", "strict")) return
  if (name !== "bash" && name !== "shell") return
  if (!commandOf(args).includes("git push")) return
  logV2("info", "[ECC] Remember to review changes before pushing: git diff origin/main...HEAD")
}

function warnDocFile(name: string, filePath: string | null, state: V2State): void {
  if (!state.hookEnabled("pre:write:doc-file-warning", ["standard", "strict"])) return
  if (name !== "write" || !filePath || !filePath.match(/\.(md|txt)$/i)) return
  if (/README|CHANGELOG|LICENSE|CONTRIBUTING/.test(filePath)) return
  logV2("warn", `[ECC] Creating ${filePath} - consider if this documentation is necessary`)
}

function warnLongRunning(name: string, args: Record<string, unknown>, state: V2State): void {
  if (!state.hookEnabled("pre:bash:tmux-reminder", "strict")) return
  if (name !== "bash" && name !== "shell") return
  const command = commandOf(args)
  const longRunning =
    /^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/.test(command) ||
    /^cargo\s+(build|test|run)/.test(command) ||
    /^go\s+(build|test|run)/.test(command)
  if (longRunning) logV2("info", "[ECC] Long-running command detected - consider using background execution")
}

async function handleToolAfter(event: V2ToolEvent | undefined, state: V2State): Promise<void> {
  const name = toolNameOf(event)
  const args = toolArgsOf(event)
  const filePath = filePathOf(args)

  recordToolChange(event, state, name, filePath)
  await runTypecheck(name, filePath, state)
  logPrCreated(name, args, state)
  trackSkillRun(name, args, event, state)
}

function recordToolChange(
  event: V2ToolEvent | undefined,
  state: V2State,
  name: string,
  filePath: string | null
): void {
  if ((name !== "write" && name !== "edit") || !filePath) return
  const key = event?.id ?? event?.callID
  const pending = key ? state.pendingToolChanges.get(key) : undefined
  if (pending) {
    state.changedFilesStore?.recordChange?.(pending.path, pending.type)
    state.pendingToolChanges.delete(key as string)
  } else {
    state.changedFilesStore?.recordChange?.(filePath, "modified")
  }
  state.editedFiles.add(filePath)
}

async function runTypecheck(name: string, filePath: string | null, state: V2State): Promise<void> {
  if (!state.hookEnabled("post:edit:typecheck", ["strict"])) return
  if (name !== "edit" || !filePath || !filePath.match(/\.tsx?$/)) return

  const result = await runCommand("npx", ["tsc", "--noEmit"], state.worktreePath)
  if (result.ok) {
    logV2("info", "[ECC] TypeScript check passed")
    return
  }
  logV2("warn", "[ECC] TypeScript errors detected:")
  const lines = `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).slice(0, 5)
  lines.forEach((line) => logV2("warn", `  ${line}`))
}

function logPrCreated(name: string, args: Record<string, unknown>, state: V2State): void {
  if (!state.hookEnabled("post:bash:pr-created", ["standard", "strict"])) return
  if (name !== "bash" && name !== "shell") return
  if (!commandOf(args).includes("gh pr create")) return
  logV2("info", "[ECC] PR created - check GitHub Actions status")
}

function trackSkillRun(
  name: string,
  args: Record<string, unknown>,
  event: V2ToolEvent | undefined,
  state: V2State
): void {
  if (!state.hookEnabled("post:skill:track", ["standard", "strict"]) || name !== "skill") return
  state.recordSkillRun?.({
    tool_name: "Skill",
    tool_input: args ?? {},
    tool_response: event?.result ?? { status: event?.status },
  })
}

/* ------------------------------------------------------------------------- *
 * permission.evaluate
 * ------------------------------------------------------------------------- */

async function registerPermissionHook(
  ctx: V2PluginContext,
  registrations: V2HookRegistration[]
): Promise<void> {
  const permission = ctx?.permission
  if (!permission?.hook) return
  const register = permission.hook
  await safeRegister("permission.hook(evaluate)", () =>
    register.call(permission, "evaluate", (event) => {
      evaluatePermission(event)
    }),
    registrations
  )
}

function permissionResources(event: V2PermissionEvaluation): string[] {
  if (Array.isArray(event.resources)) return event.resources.filter((item) => typeof item === "string")
  return typeof event.resources === "string" ? [event.resources] : []
}

/**
 * Relax "ask" to "allow" for read-only actions and safe commands.
 *
 * A v2 evaluate hook mutates `effect`; `deny` is never relaxed. Every resource
 * is classified on its own and all of them must be safe: joining the list first
 * would let `["npm test", "curl … | sh"]` pass on the strength of its first
 * entry.
 */
function evaluatePermission(event: V2PermissionEvaluation | undefined): void {
  try {
    if (!event) return
    logV2("debug", `[ECC] Permission requested for: ${event.action ?? "unknown"}`)
    if (event.effect !== "ask") return

    const action = typeof event.action === "string" ? event.action : ""
    if (READ_ONLY_ACTIONS.has(action)) {
      event.effect = "allow"
      return
    }
    if (action !== "bash" && action !== "shell") return

    const resources = permissionResources(event)
    if (resources.length > 0 && resources.every((resource) => classifySafeCommand(resource) !== null)) {
      event.effect = "allow"
    }
  } catch (error: unknown) {
    logV2("warn", `[ECC] permission hook failed: ${errorMessage(error)}`)
  }
}

/* ------------------------------------------------------------------------- *
 * session.compaction
 * ------------------------------------------------------------------------- */

async function registerCompaction(
  ctx: V2PluginContext,
  state: V2State,
  registrations: V2HookRegistration[]
): Promise<void> {
  const session = ctx?.session
  if (!session?.hook) return
  const register = session.hook
  await safeRegister("session.hook(compaction)", () =>
    register.call(session, "compaction", (event) => {
      try {
        if (!event || typeof event !== "object") return
        const block = buildCompactionContext(state)
        // OpenCode 2 passes the system prompt as parts; appending a part keeps
        // the model-generated summary while adding the ECC context. Setting
        // `event.result` would replace the summary entirely, so it is never
        // touched here.
        if (Array.isArray(event.system)) {
          event.system.push({ type: "text", text: block })
          return
        }
        // Defensive: a v1-shaped caller hands over a string[] context.
        if (Array.isArray(event.context)) event.context.push(block)
      } catch (error: unknown) {
        logV2("warn", `[ECC] compaction hook failed: ${errorMessage(error)}`)
      }
    }),
    registrations
  )
}

function buildCompactionContext(state: V2State): string {
  const lines = [
    "# ECC Context (preserve across compaction)",
    "",
    `## Active Plugin: ECC v${getECCVersion(state.eccRoot)}`,
    `- Profile: ${state.currentProfile}`,
    "- Hooks: tool.execute.before/after, session.created/idle/deleted, shell.env, compaction, permission.evaluate",
    "",
    "## Key Principles",
    "- TDD: write tests first, 80%+ coverage",
    "- Immutability: never mutate, always return new copies",
    "- Security: validate inputs, no hardcoded secrets",
    "",
  ]
  if (state.editedFiles.size > 0) {
    lines.push("## Recently Edited Files")
    for (const file of state.editedFiles) lines.push(`- ${file}`)
    lines.push("")
  }
  lines.push(
    "Focus on preserving: 1) Current task status and progress, 2) Key decisions made, 3) Files created/modified, 4) Remaining work items, 5) Any security concerns flagged. Discard: verbose tool outputs, intermediate exploration, redundant file listings."
  )
  return lines.join("\n")
}

/* ------------------------------------------------------------------------- *
 * Event stream
 * ------------------------------------------------------------------------- */

function startEventStream(ctx: V2PluginContext, state: V2State, controller: AbortController): void {
  const stream = ctx?.event
  if (!stream?.subscribe) return
  const subscribe = stream.subscribe

  let subscription: AsyncIterable<V2Event>
  try {
    subscription = subscribe.call(stream, { signal: controller.signal })
  } catch (error: unknown) {
    logV2("warn", `[ECC] could not subscribe to the event stream: ${errorMessage(error)}`)
    return
  }

  void consumeEvents(subscription, state, controller)
}

async function consumeEvents(
  subscription: AsyncIterable<V2Event>,
  state: V2State,
  controller: AbortController
): Promise<void> {
  try {
    for await (const event of subscription) {
      try {
        await handleEvent(event, state)
      } catch (error: unknown) {
        // Never let one bad event stop the stream, but do not swallow it: the
        // event type and message are what make a misbehaving handler findable.
        logV2("warn", `[ECC] event ${event?.type ?? "unknown"} handler failed: ${errorMessage(error)}`)
      }
    }
  } catch (error: unknown) {
    if (controller.signal.aborted) return
    logV2("warn", `[ECC] event stream ended: ${errorMessage(error)}`)
  }
}

async function handleEvent(event: V2Event | undefined, state: V2State): Promise<void> {
  switch (event?.type) {
    case "session.created":
      onSessionCreated(state)
      return
    case "session.idle":
      await auditEditedFiles(state)
      return
    case "session.deleted":
      onSessionDeleted(state)
      return
    case "file.edited":
      await onFileEdited(event, state)
      return
    case "filesystem.changed":
      onFilesystemChanged(event, state)
      return
    default:
      return
  }
}

function onSessionCreated(state: V2State): void {
  if (!state.hookEnabled("session:start", ["minimal", "standard", "strict"])) return
  logV2("info", `[ECC] Session started - profile=${state.currentProfile}`)
  if (state.hasProjectFile("CLAUDE.md")) {
    logV2("info", "[ECC] Found CLAUDE.md - loading project context")
  }
}

function onSessionDeleted(state: V2State): void {
  if (!state.hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
  logV2("info", "[ECC] Session ended - cleaning up")
  state.editedFiles.clear()
  state.changedFilesStore?.clearChanges?.()
  state.pendingToolChanges.clear()
}

async function onFileEdited(event: V2Event, state: V2State): Promise<void> {
  const file = fileOf(event)
  if (!file) return
  state.editedFiles.add(file)
  state.changedFilesStore?.recordChange?.(file, "modified")

  if (!SCRIPT_FILE.test(file)) return
  if (state.hookEnabled("post:edit:format", ["strict"])) await formatFile(file, state)
  if (state.hookEnabled("post:edit:console-warn", ["standard", "strict"])) warnConsoleLog(file, state)
}

async function formatFile(file: string, state: V2State): Promise<void> {
  const result = await runCommand("prettier", ["--write", state.resolvePath(file)], state.worktreePath)
  if (result.ok) {
    logV2("info", `[ECC] Formatted: ${file}`)
    return
  }
  logV2(
    "debug",
    `[ECC] Prettier formatting failed for ${file}: ${result.stderr.trim() || "prettier not available"}`
  )
}

function warnConsoleLog(file: string, state: V2State): void {
  const count = (readText(state.resolvePath(file)).match(/console\.log/g) || []).length
  if (count > 0) {
    logV2("warn", `[ECC] console.log found in ${file} (${count} occurrence${count > 1 ? "s" : ""})`)
  }
}

function onFilesystemChanged(event: V2Event, state: V2State): void {
  const file = fileOf(event)
  if (!file) return
  const kind = event.event ?? event.data?.event
  state.changedFilesStore?.recordChange?.(file, changeTypeOf(kind))
  if (kind === "change" && SCRIPT_FILE.test(file)) state.editedFiles.add(file)
}

function changeTypeOf(kind: unknown): "added" | "modified" | "deleted" {
  if (kind === "create" || kind === "add") return "added"
  if (kind === "delete" || kind === "remove" || kind === "unlink") return "deleted"
  return "modified"
}

async function auditEditedFiles(state: V2State): Promise<void> {
  if (state.editedFiles.size === 0) return
  if (!state.hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return

  logV2("info", "[ECC] Session idle - running console.log audit")
  const offenders: string[] = []
  let total = 0
  for (const file of state.editedFiles) {
    if (!SCRIPT_FILE.test(file)) continue
    const count = (readText(state.resolvePath(file)).match(/console\.log/g) || []).length
    if (count > 0) {
      total += count
      offenders.push(file)
    }
  }

  if (total > 0) {
    logV2("warn", `[ECC] Audit: ${total} console.log statement(s) in ${offenders.length} file(s)`)
    offenders.forEach((file) => logV2("warn", `  - ${file}`))
    logV2("warn", "[ECC] Remove console.log statements before committing")
  } else {
    logV2("info", "[ECC] Audit passed: No console.log statements found")
  }

  await notifyCompletion(logV2, state.worktreePath)
  state.editedFiles.clear()
}

/* ------------------------------------------------------------------------- *
 * Event helpers
 * ------------------------------------------------------------------------- */

function fileOf(event: V2Event): string | null {
  const file = event?.file ?? event?.data?.file
  return typeof file === "string" && file ? file : null
}

/** OpenCode 2 passes tool arguments as `input`; older shims used `args`. */
function toolArgsOf(event: V2ToolEvent | undefined): Record<string, unknown> {
  if (event?.input && typeof event.input === "object") {
    return event.input as Record<string, unknown>
  }
  if (event?.args && typeof event.args === "object") {
    return event.args as Record<string, unknown>
  }
  return {}
}

function toolNameOf(event: V2ToolEvent | undefined): string {
  return typeof event?.tool === "string" ? event.tool.trim().toLowerCase() : ""
}

function filePathOf(args: Record<string, unknown>): string | null {
  const candidate = args.path ?? args.filePath ?? args.file_path
  return typeof candidate === "string" && candidate.trim() ? candidate : null
}

function commandOf(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command
  if (Array.isArray(args.command)) return args.command.filter((part) => typeof part === "string").join(" ")
  return ""
}

/* ------------------------------------------------------------------------- *
 * Entrypoint
 * ------------------------------------------------------------------------- */

export const ECCHooksPluginV2 = async (ctx: V2PluginContext): Promise<(() => void) | void> => {
  const state = await createState(ctx)
  const controller = new AbortController()
  const registrations: V2HookRegistration[] = []

  await registerShellEnv(ctx, state, registrations)
  await registerToolHooks(ctx, state, registrations)
  await registerPermissionHook(ctx, registrations)
  await registerCompaction(ctx, state, registrations)
  startEventStream(ctx, state, controller)

  return () => {
    // Stop the event stream first so no callback runs against disposed state,
    // then unregister every surface hook the host gave us a handle for.
    controller.abort()
    for (const registration of registrations) {
      Promise.resolve()
        .then(() => registration.dispose?.())
        .catch((error: unknown) =>
          logV2("warn", `[ECC] could not dispose a hook registration: ${errorMessage(error)}`)
        )
    }
  }
}
