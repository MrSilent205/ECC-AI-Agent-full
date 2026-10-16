/**
 * ECC Plugin Hooks for OpenCode v2 (framework-free)
 *
 * V2-only: plain `{ id, setup }` export. No `@opencode-ai/plugin` import, so
 * this module loads in any directory without VOCODING_REQUIRED node_modules —
 * required by user-facing point 3 ("framework-free plugin").
 *
 * V2 hook registration model:
 *
 *   V1 hook                       V2 registration
 *   ----------------------------- -----------------------------------
 *   tool.execute.before           ctx.tool.hook("execute.before", ...)
 *   tool.execute.after            ctx.tool.hook("execute.after", ...)
 *   file.edited                    folded into execute.after for edit/write
 *                                     (v2 has no file.edited hook)
 *   session.created/idle/deleted   ctx.event.subscribe() filtered by type
 *   file.watcher.updated           "filesystem.changed" server event
 *   shell.env                      ctx.shell.hook("create.before", ...)
 *                                     mutating event.env (also uses event.cwd)
 *   experimental.session.compacting ctx.session.hook("compaction", ...)
 *                                     pushing the ECC block onto event.system
 *   permission.ask                 ctx.permission.hook("evaluate", ...)
 *                                     setting event.effect / event.message
 *   tool map                       ctx.tool.transform(editor.add(...))
 *
 * Behaviour notes vs v1:
 * - Bash command sniffing (git push reminder, gh pr create log, formatter and
 *   test auto-approvals) now reads the `command` input field directly. The v1
 *   code stringified the whole args object ("[object Object]"), so those
 *   branches silently never fired; they work as originally intended now.
 * - console.log auditing uses direct file reads instead of spawning grep.
 * - Shell commands run through a lazily imported `bun` $ when available, so
 *   this module can be imported under plain Node (tests); every shell call site
 *   already tolerates failure.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { createRequire } from "node:module"

const resolvedPluginDir = path.dirname(fileURLToPath(import.meta.url))

type HookProfile = "minimal" | "standard" | "strict"

interface ToolArgs {
  filePath?: unknown
  file_path?: unknown
  path?: unknown
  command?: unknown
  [key: string]: unknown
}

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
 * See original V1 comment: each probe is the exact artifact the caller is about
 * to use, so detection is layout detection rather than an authenticity control.
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
    path.resolve(resolvedPluginDir, ".."),
    path.resolve(resolvedPluginDir, "..", ".."),
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

type BunShell = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown> & { text(): Promise<string> }

let shellProbed = false
let cachedShell: BunShell | undefined
function getShell(): BunShell | undefined {
  if (!shellProbed) {
    shellProbed = true
    try {
      const require = createRequire(import.meta.url)
      cachedShell = (require("bun") as { $: BunShell }).$
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

export default {
  id: "ecc-hooks",
  async setup(ctx: any) {
    const locationDir: string =
      (ctx?.location && typeof ctx.location.directory === "string" && ctx.location.directory) ||
      process.cwd()
    const projectDir: string =
      (ctx?.location?.project &&
      typeof ctx.location.project === "object" &&
      typeof ctx.location.project.directory === "string"
        ? ctx.location.project.directory
        : locationDir) || locationDir

    const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
      if (level === "warn") console.warn(message)
      else if (level === "error") console.error(message)
      else if (level === "debug") console.debug(message)
      else console.log(message)
    }

    const editedFiles = new Set<string>()
    const pendingToolChanges = new Map<string, { path: string; type: "added" | "modified" }>()
    const sessionDirs = new Map<string, string>()

    const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
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
    const hookEnabled = (
      hookId: string,
      required: HookProfile | HookProfile[] = "standard"
    ): boolean => {
      if (disabledHooks.has(hookId)) return false
      const need = Array.isArray(required) ? required : [required]
      return need.some((entry) => profileOrder[currentProfile] >= profileOrder[entry])
    }

    async function sessionDir(sessionID: string): Promise<string> {
      const cached = sessionDirs.get(sessionID)
      if (cached) return cached
      try {
        const info = (await ctx.session.get({ sessionID })) as
          | Record<string, unknown>
          | undefined
        if (info && typeof info === "object") {
          for (const key of ["directory", "worktree", "cwd"]) {
            const value = info[key]
            if (typeof value === "string" && value) {
              sessionDirs.set(sessionID, value)
              return value
            }
          }
        }
      } catch {
        // fall through to the plugin location directory
      }
      return projectDir
    }

    // Lazily loaded changed-files store.
    let changedFilesStore:
      | typeof import("./lib/changed-files-store.ts")
      | undefined
    try {
      const store = await import("./lib/changed-files-store.ts")
      store.initStore(projectDir)
      changedFilesStore = store
    } catch {
      log(
        "warn",
        "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
          "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
      )
    }

    // Skill telemetry tracker.
    type SkillRunTrackerModule = { run?: (payload: unknown) => void }
    let recordSkillRun: ((payload: unknown) => void) | undefined
    const trackerRoot = findEccRootDir(resolvedPluginDir, ECC_ROOT_PROBES.skillTracker)
    const eccRoot =
      findEccRootDir(resolvedPluginDir, ECC_ROOT_PROBES.resolver) ??
      findEccRootDir(resolvedPluginDir, ECC_ROOT_PROBES.root)
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
      recordSkillRun = entry.run
    } catch {
      log(
        "warn",
        "[ECC] skill-run telemetry disabled: could not load scripts/hooks/skill-run-tracker.js. " +
          "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
      )
    }

    // (helpers above)

    async function runPrettier(filePath: string): Promise<void> {
      const $ = getShell()
      if (!$) {
        log("debug", `[ECC] Skipping prettier (no shell runtime): ${filePath}`)
        return
      }
      try {
        await $`prettier --write ${filePath}`
        log("info", `[ECC] Formatted: ${filePath}`)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log("debug", `[ECC] Prettier formatting failed for ${filePath}: ${msg}`)
      }
    }

    async function runTypeCheck(): Promise<void> {
      const $ = getShell()
      if (!$) {
        log("debug", "[ECC] Skipping tsc check (no shell runtime)")
        return
      }
      try {
        await $`npx tsc --noEmit`
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

    // tool.execute.before
    await ctx.tool.hook("execute.before", async (event: any) => {
      const toolName = event.tool
      const input = event.input
      const filePath = getFilePath(input)

      if (toolName === "write" && filePath) {
        const base = await sessionDir(event.sessionID)
        const absPath = resolvePath(filePath, base)
        let type: "added" | "modified" = "modified"
        try {
          type = fs.existsSync(absPath) ? "modified" : "added"
        } catch {
          type = "modified"
        }
        pendingToolChanges.set(String(event.id), { path: filePath, type })
      }

      const command = getCommand(input)

      if (
        hookEnabled("pre:bash:git-push-reminder", "strict") &&
        toolName === "bash" &&
        command.includes("git push")
      ) {
        log("info", "[ECC] Remember to review changes before pushing: git diff origin/main...HEAD")
      }

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

      if (hookEnabled("pre:bash:tmux-reminder", "strict") && toolName === "bash") {
        if (
          command.match(/^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/) ||
          command.match(/^cargo\s+(build|test|run)/) ||
          command.match(/^go\s+(build|test|run)/)
        ) {
          log("info", "[ECC] Long-running command detected - consider using background execution")
        }
      }
    })

    // tool.execute.after — change tracking, format, typecheck + absorbs file.edited
    await ctx.tool.hook("execute.after", async (event: any) => {
      if (event.status !== "completed") return
      const toolName = event.tool
      const input = event.input
      const filePath = getFilePath(input)

      if (toolName === "edit" && filePath) {
        changedFilesStore?.recordChange(filePath, "modified")
      }
      if (toolName === "write" && filePath) {
        const key = String(event.id)
        const pending = pendingToolChanges.get(key)
        if (pending) {
          changedFilesStore?.recordChange(pending.path, pending.type)
          pendingToolChanges.delete(key)
        } else {
          changedFilesStore?.recordChange(filePath, "modified")
        }
      }

      if ((toolName === "edit" || toolName === "write") && filePath) {
        editedFiles.add(filePath)

        if (hookEnabled("post:edit:format", ["strict"]) && filePath.match(/\.(ts|tsx|js|jsx)$/)) {
          await runPrettier(filePath)
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
        await runTypeCheck()
      }

      const command = getCommand(input)
      if (
        hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
        toolName === "bash" &&
        command.includes("gh pr create")
      ) {
        log("info", "[ECC] PR created - check GitHub Actions status")
      }

      // Skill telemetry (#2463)
      if (
        hookEnabled("post:skill:track", ["standard", "strict"]) &&
        typeof toolName === "string" &&
        toolName.trim().toLowerCase() === "skill"
      ) {
        try {
          recordSkillRun?.({
            tool_name: "Skill",
            tool_input: input ?? {},
            tool_response: event.output,
          })
        } catch {
          // Telemetry is best-effort; never let it affect the tool result.
        }
      }
    })

    // shell.create.before — environment injection (v1 shell.env)
    await ctx.shell.hook("create.before", (event: any) => {
      const base = event.cwd || projectDir
      const eccVersion = getECCVersion(eccRoot)
      event.env = event.env || {}
      event.env.ECC_VERSION = eccVersion
      event.env.ECC_PLUGIN = "true"
      event.env.ECC_HOOK_PROFILE = currentProfile
      event.env.ECC_DISABLED_HOOKS = process.env.ECC_DISABLED_HOOKS || ""
      event.env.PROJECT_ROOT = base

      const lockfiles: Record<string, string> = {
        "bun.lockb": "bun",
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "package-lock.json": "npm",
      }
      for (const [lockfile, pm] of Object.entries(lockfiles)) {
        if (hasProjectFile(lockfile, base)) {
          event.env.PACKAGE_MANAGER = pm
          break
        }
      }

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
        event.env.DETECTED_LANGUAGES = detected.join(",")
        event.env.PRIMARY_LANGUAGE = detected[0]
      }

      // Export CLAUDE_PLUGIN_ROOT so commands can resolve ECC root (V1 preserved).
      const rootAlreadySet = Boolean(
        (process.env.CLAUDE_PLUGIN_ROOT || "").trim() ||
          (event.env?.CLAUDE_PLUGIN_ROOT || "").trim()
      )
      if (eccRoot && !rootAlreadySet) {
        event.env.CLAUDE_PLUGIN_ROOT = eccRoot
      }
    })

    // permission.evaluate — audit + auto-approve safe ops
    await ctx.permission.hook("evaluate", async (event: any) => {
      // changedFilesTool changedFiles parser?
      const action = event.action
      log("info", `[ECC] Permission requested: action=${action}`)

      try {
        const resourcesText = Array.isArray(event.resources)
          ? event.resources.join("\n")
          : String(event.resources ?? "")

        if (["read", "glob", "grep", "search", "list"].includes(action)) {
          log("debug", `[ECC] Auto-approved read-only action: ${action}`)
          event.effect = "allow"
          event.message = "Read-only operation"
          return
        }

        if (
          action === "bash" &&
          /^(npx )?(@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)/.test(resourcesText.trim())
        ) {
          log("debug", "[ECC] Auto-approved formatter")
          event.effect = "allow"
          event.message = "Formatter execution"
          return
        }

        if (
          action === "bash" &&
          /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)/.test(resourcesText.trim())
        ) {
          log("debug", "[ECC] Auto-approved test execution")
          event.effect = "allow"
          event.message = "Test execution"
          return
        }

        log("debug", `[ECC] Permission requires user decision: ${action}`)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log("error", `[ECC] Permission handling error for ${action}: ${msg}`)
        event.effect = "deny"
        event.message = `Error: ${msg}`
      }
    })

    // compaction hook
    await ctx.session.hook("compaction", (event: any) => {
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
      if (Array.isArray(event.system)) {
        event.system.push({ type: "text", text: lines.join("\n") })
      }
    })

    // Register custom tools (changed-files, dependency-analyzer).
    try {
      const { executeChangedFiles } = await import("../tools/changed-files.ts")
      const { executeDependencyAnalyzer } = await import("../tools/dependency-analyzer.ts")
      const { changedFilesDescription } = await import("../tools/changed-files.ts")
      const { dependencyAnalyzerDescription } = await import("../tools/dependency-analyzer.ts")

      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "changed-files",
          description: changedFilesDescription,
          input: {
            type: "object",
            properties: {
              filter: {
                type: "string",
                enum: ["all", "added", "modified", "deleted"],
                description: "Filter by change type (default: all)",
              },
              format: {
                type: "string",
                enum: ["tree", "json"],
                description: "Output format (default: tree)",
              },
            },
            additionalProperties: false,
          },
          execute: async (raw: unknown) => ({
            content: await executeChangedFiles((raw ?? {}) as any, projectDir),
          }),
        })
        editor.add({
          name: "dependency-analyzer",
          description: dependencyAnalyzerDescription,
          input: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["all", "outdated", "security", "unused"],
                description: "Type of analysis (default: all)",
              },
              fix: { type: "boolean", description: "Fix automatically" },
              depth: { type: "number", description: "Depth" },
            },
            additionalProperties: false,
          },
          execute: async (raw: unknown) => ({
            content: await executeDependencyAnalyzer((raw ?? {}) as any, projectDir),
          }),
        })
      })
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("warn", `[ECC] Custom tools disabled: could not load tool runners. ${msg}`)
    }

    // Session lifecycle + filesystem events via server event stream.
    const onSessionCreated = (data: Record<string, unknown>) => {
      if (!hookEnabled("session:start", ["minimal", "standard", "strict"])) return
      log("info", `[ECC] Session started - profile=${currentProfile}`)
      const dir = typeof data.directory === "string" ? data.directory : projectDir
      if (hasProjectFile("CLAUDE.md", dir)) {
        log("info", "[ECC] Found CLAUDE.md - loading project context")
      }
    }

    const onSessionIdle = async () => {
      if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
      if (editedFiles.size === 0) return
      log("info", "[ECC] Session idle - running console.log audit")

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

      try {
        const $ = getShell()
        if (!$) {
          log("debug", "[ECC] Skipping desktop notification (no shell runtime)")
        } else if (process.platform === "darwin") {
          await $`osascript -e 'display notification "Task completed!" with title "OpenCode ECC"'`
        } else if (process.platform === "win32") {
          await $`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')"`
        } else if (process.platform === "linux") {
          await $`notify-send "OpenCode ECC" "Task completed!"`
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log("debug", `[ECC] Desktop notification failed: ${msg}`)
      }

      editedFiles.clear()
    }

    const onSessionDeleted = () => {
      if (!hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
      log("info", "[ECC] Session ended - cleaning up")
      editedFiles.clear()
      changedFilesStore?.clearChanges()
      pendingToolChanges.clear()
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const evt = raw as unknown as { type?: unknown; data?: unknown }
          if (typeof evt.type !== "string") continue
          const data =
            evt.data && typeof evt.data === "object"
              ? (evt.data as Record<string, unknown>)
              : {}
          try {
            switch (evt.type) {
              case "session.created":
                onSessionCreated(data)
                break
              case "session.idle":
                await onSessionIdle()
                break
              case "session.deleted":
                onSessionDeleted()
                break
              case "filesystem.changed": {
                const file = data.file
                const kind = data.event
                if (typeof file !== "string" || !file) break
                const changeType =
                  kind === "add" ? "added" : kind === "unlink" ? "deleted" : "modified"
                changedFilesStore?.recordChange(file, changeType)
                if (kind === "change" && file.match(/\.(ts|tsx|js|jsx)$/)) {
                  editedFiles.add(file)
                }
                break
              }
              default:
                break
            }
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error)
            log("debug", `[ECC] Event handler error (${evt.type}): ${msg}`)
          }
        }
      } catch {
        // Aborted on unload — expected.
      }
    })()

    log("info", `[ECC] Plugin loaded - profile=${currentProfile}`)
    return () => controller.abort()
  },
}
