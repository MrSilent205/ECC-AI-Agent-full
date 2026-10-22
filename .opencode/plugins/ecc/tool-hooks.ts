/**
 * Tool lifecycle hooks for the ECC OpenCode runtime.
 *
 * Runs the pre-tool warnings, the post-edit formatting and type checks, the
 * change bookkeeping, and the skill telemetry.
 */

import * as fs from "fs"

import type { ChangedFilesStore, HookGate, LogFn, ShellFn } from "./types.ts"
import { countConsoleLogs, getCommand, getFilePath, resolvePath } from "./environment.ts"

interface FormatterContext {
  log: LogFn
  shell: ShellFn | undefined
}

interface ToolHookContext {
  projectDir: string
  log: LogFn
  shell: ShellFn | undefined
  hookEnabled: HookGate
  editedFiles: Set<string>
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
  changedFilesStore: ChangedFilesStore | undefined
  recordSkillRun: ((payload: unknown) => void) | undefined
  sessionDir: (sessionID: string | undefined) => Promise<string>
}

export function createFormatter(context: FormatterContext): {
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
    hookEnabled("post:edit:typecheck", "strict") &&
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

export function createToolHooks(context: ToolHookContext): {
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
  const formatter = createFormatter({ log: context.log, shell: context.shell })

  async function toolBefore(
    toolName: string,
    input: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void> {
    await recordPendingWrite(
      toolName, input, sessionID, callID, context.sessionDir, context.pendingToolChanges
    )
    warnBeforeTool(toolName, getFilePath(input), getCommand(input), context.hookEnabled, context.log)
  }

  async function toolAfter(
    toolName: string,
    input: unknown,
    output: unknown,
    _sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void> {
    const filePath = getFilePath(input)
    const { changedFilesStore, pendingToolChanges, hookEnabled, log } = context
    recordToolChange(toolName, filePath, callID, changedFilesStore, pendingToolChanges)
    await warnAfterEdit(
      toolName, filePath, context.projectDir, hookEnabled, context.editedFiles, log, formatter
    )
    warnAfterBash(toolName, getCommand(input), hookEnabled, log)
    trackSkillRun(toolName, input, output, hookEnabled, context.recordSkillRun)
  }

  return { toolBefore, toolAfter }
}
