/**
 * Shared runtime for the ECC OpenCode plugin.
 *
 * Both contract implementations need the same primitives: ECC-root and version
 * discovery, the hook profile gate, the lazily loaded optional modules, the
 * safe-command classifier used by permission hooks, and the child-process
 * runner. Keeping them here means the v1 surface (`v1-hooks.ts`) and the v2
 * surface (`v2-hooks.ts`) cannot drift apart on a security-relevant rule.
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath, pathToFileURL } from "url"

/**
 * Directory that holds the plugin entrypoint (`.../plugins`).
 *
 * This module lives one level below it (`plugins/lib/`), so both the source
 * layout (`.opencode/plugins/lib/*.ts`) and the compiled bundle
 * (`dist/plugins/lib/*.js`) resolve to `<plugin dir>/lib`.
 *
 * `import.meta.url` is the only source of truth here. A `__dirname` fallback
 * looks tempting for a CJS consumer, but this package is `"type": "module"` and
 * `__dirname` is not a module-local in ESM — it can only ever be a *global*
 * someone else defined (Node's own `-e` runner sets `globalThis.__dirname` to
 * `"."`), which silently resolved the plugin dir to the process cwd and made
 * every store/root probe fail.
 */
export const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Artifacts that identify an ECC root, one per capability this plugin needs.
 *
 * These are required runtime files, never optional content: `skills/` belongs to
 * the optional `workflow-quality` module, so probing for a skill rejected
 * supported modular installs (e.g. `platform-configs` + `hooks-runtime` without
 * `workflow-quality`) that still ship both the plugin and the tracker — silently
 * disabling skill telemetry and the shell root export for those users.
 *
 * Each probe is the exact artifact the caller is about to use, so detection is
 * layout detection rather than an authenticity control: a directory only
 * qualifies because it contains what we are going to read.
 */
export const ECC_ROOT_PROBES = {
  // scripts/lib/utils.js is the shared library every scripts/ module requires.
  root: [path.join("scripts", "lib", "utils.js")],
  // What the skill-run telemetry hook imports at runtime.
  skillTracker: [path.join("scripts", "hooks", "skill-run-tracker.js")],
  // What the resolver embedded in commands requires once they read
  // CLAUDE_PLUGIN_ROOT, and the version lookup for shell.env.
  resolver: [path.join("scripts", "lib", "resolve-ecc-root.js")],
} as const

/**
 * Walk upwards from `startDir` looking for an ancestor that contains every
 * relative path in `probes`.
 *
 * The plugin ships in three layouts — `<root>/plugins` (installed), `<root>/dist/plugins`
 * (compiled) and `<repo>/.opencode/plugins` (repo checkout) — so the number of
 * levels back to the root is not fixed. Probing beats a hardcoded `..`: a wrong
 * root would make every command resolve against a directory that has no scripts.
 *
 * The walk is bounded to 5 levels so it cannot wander into unrelated ancestors.
 *
 * Returns null when no ancestor qualifies, so callers can leave the capability
 * disabled instead of advertising a root that does not hold the artifact.
 */
export function findEccRootDir(startDir: string, probes: readonly string[]): string | null {
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

/**
 * Read the ECC version from package.json.
 *
 * Candidates are tried in order — the resolved ECC root first, then the two
 * plausible parent depths of the plugin — because the layout differs between an
 * installed root (`<root>/plugins`), the compiled bundle (`<root>/dist/plugins`)
 * and a repo checkout (`<repo>/.opencode/plugins`). Falls back to a default if
 * no package.json can be read.
 */
export function getECCVersion(eccRootDir?: string | null): string {
  const candidates = [
    eccRootDir,
    path.resolve(PLUGIN_DIR, ".."),
    path.resolve(PLUGIN_DIR, "..", ".."),
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

export type HookProfile = "minimal" | "standard" | "strict"

const PROFILE_ORDER: Record<HookProfile, number> = {
  minimal: 0,
  standard: 1,
  strict: 2,
}

function normalizeProfile(value: string | undefined): HookProfile {
  if (value === "minimal" || value === "strict") return value
  return "standard"
}

export interface HookGate {
  currentProfile: HookProfile
  hookEnabled: (hookId: string, requiredProfile?: HookProfile | HookProfile[]) => boolean
}

/**
 * Read the hook profile and disabled-hook list from the environment.
 *
 * Called once per plugin instance rather than at module evaluation so a test or
 * a reload can change `ECC_HOOK_PROFILE` / `ECC_DISABLED_HOOKS` between loads.
 */
export function createHookGate(): HookGate {
  const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
  const disabledHooks = new Set(
    (process.env.ECC_DISABLED_HOOKS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )

  const profileAllowed = (required: HookProfile | HookProfile[]): boolean => {
    if (Array.isArray(required)) {
      return required.some((entry) => PROFILE_ORDER[currentProfile] >= PROFILE_ORDER[entry])
    }
    return PROFILE_ORDER[currentProfile] >= PROFILE_ORDER[required]
  }

  const hookEnabled = (
    hookId: string,
    requiredProfile: HookProfile | HookProfile[] = "standard"
  ): boolean => {
    if (disabledHooks.has(hookId)) return false
    return profileAllowed(requiredProfile)
  }

  return { currentProfile, hookEnabled }
}

export type LogLevel = "debug" | "info" | "warn" | "error"
export type DiagnosticLog = (level: LogLevel, message: string) => void

const V2_CONSOLE_METHOD: Record<LogLevel, "warn" | "error"> = {
  debug: "warn",
  info: "warn",
  warn: "warn",
  error: "error",
}

/**
 * The single diagnostic sink for the OpenCode 2 surface.
 *
 * OpenCode 2's plugin context exposes no log API equivalent to v1's
 * `client.app.log`, so every message leaves through this one function.
 *
 * Both methods write to stderr on purpose. `console.log` (and `console.info`,
 * which is the same stream) writes to stdout, which OpenCode owns for its own
 * TUI output — a plugin writing there can corrupt the rendered frame. The
 * severity is carried in the `[ecc:<level>]` prefix instead of by choosing a
 * stdout sink. Callers never touch `console` directly, and logging can never
 * break a hook.
 */
export const logV2: DiagnosticLog = (level, message) => {
  try {
    console[V2_CONSOLE_METHOD[level]](`[ecc:${level}] ${message}`)
  } catch {
    // Logging must never break a hook.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------------- *
 * Safe-command classification
 *
 * Both permission surfaces auto-approve a small allowlist: formatters and test
 * runners. Matching is deliberately conservative — the command must be a single
 * command whose control operators, substitutions and grouping are absent — so a
 * prefix match can never approve `npm test && curl … | sh`.
 * ------------------------------------------------------------------------- */

const SAFE_FORMATTER = /^(?:npx )?(?:@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)(?:\s|$)/
const SAFE_TEST = /^(?:npm test|npx vitest|npx jest|pytest|go test|cargo test)(?:\s|$)/

/**
 * Shell control syntax: command separators, pipes, redirections, command
 * substitution, backticks, grouping, brace expansion and line breaks.
 *
 * Parentheses are rejected because `(cmd)` runs a subshell. Quotes are not
 * rejected, so `pytest -k "not slow"` still qualifies.
 */
const SHELL_CONTROL = /[;&|<>`$(){}\n\r]/

export type SafeCommandKind = "formatter" | "test"

/**
 * Classify a single command line as a safe formatter or test invocation.
 *
 * Returns null for anything else, including a compound command that merely
 * starts with a safe prefix. Each resource handed to a permission hook must be
 * classified separately; joining them first would reintroduce the bypass.
 */
export function classifySafeCommand(command: string): SafeCommandKind | null {
  const trimmed = command.trim()
  if (!trimmed || SHELL_CONTROL.test(trimmed)) return null
  if (SAFE_FORMATTER.test(trimmed)) return "formatter"
  if (SAFE_TEST.test(trimmed)) return "test"
  return null
}

/* ------------------------------------------------------------------------- *
 * Child processes
 * ------------------------------------------------------------------------- */

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Quote one Windows command-line token for `cmd.exe`.
 *
 * Values without spaces or cmd metacharacters pass through unchanged; anything
 * else is wrapped in double quotes with embedded quotes doubled, which keeps
 * separators and redirections literal.
 */
function quoteWindowsToken(value: string): string {
  if (!/[\s"&|<>^%]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function windowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsToken).join(" ")
}

/**
 * Resolve the executable to spawn.
 *
 * npm-installed CLIs (`npx`, `prettier`, …) are `.cmd` shims on Windows and
 * cannot be spawned directly — Node raises `EINVAL` for them since the
 * CVE-2024-27980 fix. Those go through `cmd.exe`; real executables
 * (`powershell.exe`) are spawned as-is. On POSIX the command is spawned
 * directly, with no shell in the path.
 */
function commandInvocation(
  command: string,
  args: string[]
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32") return { file: command, args }
  if (/\.(?:exe|com)$/i.test(command)) return { file: command, args }
  if (command === "powershell") return { file: "powershell.exe", args }
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${windowsCommandLine(command, args)}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * Run a command without blocking the OpenCode server thread.
 *
 * The previous implementation used `spawnSync`, which stalled every session in
 * the process for the duration of a formatter or `tsc` run.
 */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout = 120_000
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const invocation = commandInvocation(command, args)
      const child = spawn(invocation.file, invocation.args, {
        cwd,
        timeout,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
      })

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", (error) => finish({ ok: false, stdout, stderr: stderr + errorMessage(error) }))
      child.on("close", (code, signal) => finish({ ok: code === 0 && !signal, stdout, stderr }))
    } catch (error: unknown) {
      finish({ ok: false, stdout, stderr: errorMessage(error) })
    }
  })
}

/**
 * Best-effort desktop notification for the "session idle" hook.
 *
 * Returns nothing; a missing notifier is an unsupported platform feature, not
 * an error the session should surface.
 */
export async function notifyCompletion(log: DiagnosticLog, cwd: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { file: "osascript", args: ["-e", 'display notification "Task completed!" with title "OpenCode ECC"'] }
      : process.platform === "win32"
        ? {
            file: "powershell",
            args: [
              "-NoProfile",
              "-Command",
              "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')",
            ],
          }
        : process.platform === "linux"
          ? { file: "notify-send", args: ["OpenCode ECC", "Task completed!"] }
          : null

  if (!command) return
  const result = await runCommand(command.file, command.args, cwd, 10_000)
  if (!result.ok) {
    log("debug", `[ECC] Desktop notification failed: ${result.stderr.trim() || "unsupported"}`)
  }
}

export function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8")
  } catch {
    return ""
  }
}

/* ------------------------------------------------------------------------- *
 * Optional modules
 *
 * Each loader probes the source and compiled layouts instead of importing a
 * specifier that only one layout resolves. Callers turn a failure into one
 * capability being disabled rather than a failed plugin setup; this file is
 * OpenCode's startup entry point, so a thrown import error took the whole
 * session down before (#2530).
 * ------------------------------------------------------------------------- */

export type ChangedFilesStore = {
  initStore?: (worktree: string) => void
  recordChange?: (filePath: string, type: "added" | "modified" | "deleted") => void
  clearChanges?: () => void
}

export async function loadChangedFilesStore(
  pluginDir: string = PLUGIN_DIR
): Promise<ChangedFilesStore | undefined> {
  const candidates = [
    path.join(pluginDir, "lib", "changed-files-store.ts"),
    path.join(pluginDir, "lib", "changed-files-store.js"),
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    return (await import(pathToFileURL(candidate).href)) as ChangedFilesStore
  }
  throw new Error("changed-files-store not found")
}

export async function loadSkillRunTracker(
  pluginDir: string = PLUGIN_DIR
): Promise<((payload: unknown) => void) | undefined> {
  const trackerRoot = findEccRootDir(pluginDir, ECC_ROOT_PROBES.skillTracker)
  const trackerPath = trackerRoot ? path.join(trackerRoot, "scripts", "hooks", "skill-run-tracker.js") : null
  if (!trackerPath || !fs.existsSync(trackerPath)) {
    throw new Error("skill-run-tracker.js not found")
  }
  // CJS module loaded from ESM: run() is on the namespace in Node/Bun, but a
  // transpiled default export must stay supported.
  const loaded = (await import(pathToFileURL(trackerPath).href)) as {
    run?: (payload: unknown) => void
    default?: { run?: (payload: unknown) => void }
  }
  const entry = typeof loaded.run === "function" ? loaded : loaded.default
  if (!entry || typeof entry.run !== "function") {
    throw new Error("skill-run-tracker.js exposes no run()")
  }
  return entry.run
}
