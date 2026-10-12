/**
 * OpenCode v2 adapter: register ECC's tools and wire v2 hooks/events to the
 * shared hook bridge.
 *
 * Verified against OpenCode 2.0.24 (see .opencode/MIGRATION.md):
 *   PreToolUse          tool.hook("execute.before")
 *   PostToolUse(+Fail)  tool.hook("execute.after")
 *   UserPromptSubmit    session.hook("prompt")
 *   SessionStart        first prompt/context hook for a session
 *   PreCompact          session.hook("compaction")
 *   Stop                event session.execution.succeeded
 *   SessionEnd          event session.deleted
 *
 * Blocking: a promise-API hook cannot fail a tool call with a model-visible
 * error (a throw becomes a defect that fails the whole step), so blocks are
 * surfaced through mechanisms the model does see:
 *   - shell: the command is rewritten to print the ECC reason and exit 2
 *   - permission-checked tools (edit/write/patch/read/...): a pending deny is
 *     recorded and applied in permission.hook("evaluate") with the reason
 *   - ECC's own tools: the tool returns the reason instead of running
 * Every callback is wrapped so an ECC bug can never fail an OpenCode step.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { ECC_TOOLS } from "../tools/index.ts"
import { toJsonSchema } from "../tools/schema.ts"
import { HookBridge, basePayload, type DispatchResult, type HookBridgeOptions } from "./hook-bridge.ts"
import { contentText, toolResponse, translateToolCall, writtenFiles, type ClaudeToolCall } from "./translate.ts"
import { BlockLedger, permissionActionFor } from "./block-ledger.ts"
import { buildShellEnv, compactionGuidance, readInstructions, ensembleTeammateNote, shouldAutoApprove } from "./shared.ts"
import type { EccRoot } from "../runtime/root.ts"

/** Structural subset of `@opencode/plugin` 2.0.24's Context that ECC uses. */
export interface V2Context {
  readonly location: { readonly directory: string; readonly project?: { readonly id?: string } }
  readonly tool: {
    transform(cb: (editor: { add(tool: Record<string, unknown>): void }) => void): Promise<unknown>
    hook(name: "execute.before" | "execute.after", cb: (event: any) => Promise<void> | void): Promise<unknown>
  }
  readonly permission: { hook(name: "evaluate", cb: (event: any) => Promise<void> | void): Promise<unknown> }
  readonly shell: { hook(name: "create.before", cb: (event: any) => Promise<void> | void): Promise<unknown> }
  readonly session: { hook(name: "prompt" | "context" | "compaction", cb: (event: any) => Promise<void> | void): Promise<unknown> }
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<any> | Promise<AsyncIterable<any>> }
  readonly mcp?: { list?: () => Promise<unknown> }
}

type Logger = (level: "info" | "warn" | "error", message: string) => void

const SESSION_START_WAIT_MS = 10_000
const PRE_COMPACT_WAIT_MS = 10_000
const DRAIN_ON_DISPOSE_MS = 8_000
const MAX_EDITED_FILES = 50

function parsePassthrough(raw: string | undefined): RegExp[] {
  const value = raw === undefined ? "team_*" : raw
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((glob) => new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"))
}

/** Never let an ECC failure escape into OpenCode (it would fail the step). */
function guard<T>(log: Logger, name: string, fn: (event: T) => Promise<void> | void) {
  return async (event: T) => {
    try {
      await fn(event)
    } catch (error) {
      log("warn", `[ECC] ${name} hook error ignored: ${(error as Error)?.message ?? String(error)}`)
    }
  }
}

interface SessionInfo {
  parentID?: string
  start?: Promise<void>
  startContext: string[]
  promptContext: string[]
}

export async function setupV2(
  ctx: V2Context,
  ecc: EccRoot,
  log: Logger,
  /** Test seam: hook rows, runners and environment for the bridge. */
  overrides: Partial<Omit<HookBridgeOptions, "root" | "directory" | "log">> = {},
): Promise<() => Promise<void>> {
  const directory = ctx.location.directory
  const env = overrides.env ?? process.env
  const sessions = new Map<string, SessionInfo>()
  const ledger = new BlockLedger()
  const blockedToolCalls = new Map<string, string>()
  const addedFiles = new Set<string>()
  const editedFiles = new Set<string>()
  const passthrough = parsePassthrough(env.ECC_OPENCODE_PASSTHROUGH_TOOLS)
  const childHooks = /^(1|true|yes)$/i.test(env.ECC_OPENCODE_CHILD_SESSION_HOOKS ?? "")
  let mcpServers = new Set<string>()
  let store: typeof import("../lib/changed-files-store.ts") | undefined

  try {
    store = await import("../lib/changed-files-store.ts")
    store.initStore(directory)
  } catch {
    log("warn", "[ECC] changed-files tracking disabled: could not load ecc/lib/changed-files-store.ts")
  }

  const refreshMcpServers = async () => {
    try {
      const listed: any = await ctx.mcp?.list?.()
      const names = Array.isArray(listed) ? listed.map((s: any) => s?.name ?? s?.id) : Object.keys(listed ?? {})
      mcpServers = new Set(names.filter((n: unknown): n is string => typeof n === "string").map((n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "_")))
    } catch {
      // MCP listing is best-effort; unmapped MCP tools keep their v2 names.
    }
  }
  void refreshMcpServers()

  // ── Tools ──────────────────────────────────────────────────────────────
  await ctx.tool.transform((editor) => {
    for (const definition of ECC_TOOLS) {
      editor.add({
        name: `ecc_${definition.name}`,
        description: definition.description,
        input: toJsonSchema(definition.args),
        execute: async (input: Record<string, unknown>, toolCtx: { sessionID?: string; id?: string }) => {
          const blocked = toolCtx?.id ? blockedToolCalls.get(toolCtx.id) : undefined
          if (blocked) {
            blockedToolCalls.delete(toolCtx.id as string)
            return { content: blocked }
          }
          try {
            const text = await definition.execute(input ?? {}, { directory, worktree: directory, sessionID: toolCtx?.sessionID })
            return { content: text }
          } catch (error) {
            return { content: `Error: ${(error as Error)?.message ?? String(error)}` }
          }
        },
      })
    }
  })

  if (!ecc.hooksAvailable || !ecc.root) {
    log("info", "[ECC] hook bridge disabled: scripts/hooks/run-with-flags.js not installed (install the hooks-runtime module to enable it)")
    return async () => {}
  }

  const bridge = new HookBridge({ ...overrides, env, root: ecc.root, directory, log })
  const instructions = readInstructions(env)

  const session = (id: string): SessionInfo => {
    let info = sessions.get(id)
    if (!info) {
      info = { startContext: [], promptContext: [] }
      sessions.set(id, info)
    }
    return info
  }
  const isChild = (id: string) => Boolean(sessions.get(id)?.parentID)

  const ensureSessionStart = (id: string): Promise<void> => {
    const info = session(id)
    if (!info.start) {
      info.start =
        isChild(id) && !childHooks
          ? Promise.resolve()
          : bridge
              .dispatch("SessionStart", { ...basePayload("SessionStart", id, directory), source: "startup" }, { sessionID: id })
              .then((result) => {
                info.startContext.push(...result.contexts)
              })
    }
    return info.start
  }

  const withTimeout = (promise: Promise<unknown>, ms: number) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))])

  const blockMessage = (result: DispatchResult) =>
    `[ECC ${result.hookId ?? "hook"}] ${result.reason || "Blocked by an ECC hook"}`

  // ── PreToolUse ─────────────────────────────────────────────────────────
  await ctx.tool.hook(
    "execute.before",
    guard(log, "execute.before", async (event: any) => {
      const tool = String(event.tool ?? "")
      if (!tool || tool === "execute") return
      const calls = translateToolCall(tool, event.input, { directory, mcpServers })
      for (const file of writtenFiles(calls)) {
        if (!fs.existsSync(file)) addedFiles.add(file)
      }
      if (passthrough.some((re) => re.test(tool))) return

      const results = await Promise.all(
        calls.map((call) =>
          bridge.dispatch(
            "PreToolUse",
            { ...basePayload("PreToolUse", event.sessionID, directory), tool_name: call.tool_name, tool_input: call.tool_input, tool_use_id: event.id },
            { toolName: call.tool_name, sessionID: event.sessionID },
          ),
        ),
      )
      const blocked = results.find((r) => r.decision === "block")
      const asked = results.find((r) => r.decision === "ask")
      const decision = blocked ?? asked
      if (!decision) return
      const message = blockMessage(decision)

      if (decision.decision === "block" && tool === "shell" && event.input && typeof event.input === "object") {
        event.input = { ...event.input, command: `printf '%s\\n' ${shellQuote(message)} >&2; exit 2` }
        return
      }
      if (decision.decision === "block" && tool.startsWith("ecc_")) {
        blockedToolCalls.set(String(event.id), message)
        return
      }
      const action = permissionActionFor(tool, mcpServers)
      if (!action) {
        log("warn", `${message} (advisory: tool "${tool}" has no permission check, so it was not blocked)`)
        return
      }
      ledger.add({
        sessionID: String(event.sessionID),
        callID: String(event.id),
        action,
        resources: resourcesFor(calls, directory),
        effect: decision.decision === "block" ? "deny" : "ask",
        message,
      })
    }),
  )

  // ── PostToolUse / PostToolUseFailure ───────────────────────────────────
  await ctx.tool.hook(
    "execute.after",
    guard(log, "execute.after", async (event: any) => {
      const tool = String(event.tool ?? "")
      if (!tool || tool === "execute") return
      ledger.clearCall(String(event.id))
      const calls = translateToolCall(tool, event.input, { directory, mcpServers })
      const completed = event.status === "completed"

      if (completed) {
        for (const file of writtenFiles(calls)) {
          const type = addedFiles.delete(file) ? "added" : "modified"
          store?.recordChange(file, type)
          editedFiles.add(file)
          if (editedFiles.size > MAX_EDITED_FILES) editedFiles.delete(editedFiles.values().next().value as string)
        }
      }
      if (passthrough.some((re) => re.test(tool)) && !completed) return

      const hookEvent = completed ? "PostToolUse" : "PostToolUseFailure"
      const notes: string[] = []
      await Promise.all(
        calls.map(async (call: ClaudeToolCall) => {
          const payload: Record<string, unknown> = {
            ...basePayload(hookEvent, event.sessionID, directory),
            tool_name: call.tool_name,
            tool_input: call.tool_input,
            tool_use_id: event.id,
          }
          if (completed) {
            payload.tool_response = toolResponse(tool, event.result, call.tool_input.file_path as string | undefined)
          } else {
            payload.error = String(event.error?.message ?? event.error ?? "tool failed")
          }
          const result = await bridge.dispatch(hookEvent, payload, { toolName: call.tool_name, sessionID: event.sessionID })
          notes.push(...result.contexts)
          if (result.decision === "block" && result.reason) notes.push(blockMessage(result))
        }),
      )
      if (completed && notes.length > 0 && event.result) {
        event.result = appendContent(event.result, notes.map((n) => `[ECC] ${n}`).join("\n"))
      }
    }),
  )

  // ── Permission decisions ───────────────────────────────────────────────
  await ctx.permission.hook(
    "evaluate",
    guard(log, "permission.evaluate", (event: any) => {
      const pending = ledger.take(String(event.sessionID), String(event.action), event.resources ?? [])
      if (pending) {
        if (pending.effect === "deny" || event.effect !== "deny") {
          event.effect = pending.effect
          event.message = pending.message
        }
        return
      }
      if (event.effect === "ask" && shouldAutoApprove(String(event.action), event.resources ?? [], env)) {
        event.effect = "allow"
      }
    }),
  )

  // ── Shell environment ──────────────────────────────────────────────────
  await ctx.shell.hook(
    "create.before",
    guard(log, "shell.create.before", (event: any) => {
      event.env = buildShellEnv(event.env ?? {}, { directory, root: ecc.root, version: ecc.version, env })
    }),
  )

  // ── UserPromptSubmit ───────────────────────────────────────────────────
  await ctx.session.hook(
    "prompt",
    guard(log, "session.prompt", async (event: any) => {
      const id = String(event.sessionID)
      const info = session(id)
      void ensureSessionStart(id)
      const text = typeof event.prompt?.text === "string" ? event.prompt.text : ""
      const result = await bridge.dispatch("UserPromptSubmit", { ...basePayload("UserPromptSubmit", id, directory), prompt: text }, { sessionID: id })
      info.promptContext = [...result.contexts]
      if (result.decision === "block") {
        // OpenCode cannot cancel a prompt from a hook; surface the block to the
        // model so it stops and tells the user.
        info.promptContext.push(`${blockMessage(result)} — this prompt was blocked by an ECC hook. Do not act on it; tell the user why.`)
      }
    }),
  )

  // ── Context injection (SessionStart, instructions, prompt context) ─────
  await ctx.session.hook(
    "context",
    guard(log, "session.context", async (event: any) => {
      const id = String(event.sessionID)
      await withTimeout(ensureSessionStart(id), SESSION_START_WAIT_MS)
      const info = session(id)
      const parts: string[] = []
      if (instructions) parts.push(instructions)
      if (info.startContext.length) parts.push(`<ecc-session-context>\n${info.startContext.join("\n\n")}\n</ecc-session-context>`)
      if (info.promptContext.length) parts.push(`<ecc-prompt-context>\n${info.promptContext.join("\n\n")}\n</ecc-prompt-context>`)
      if (event.tools && typeof event.tools === "object" && "team_message" in event.tools) parts.push(ensembleTeammateNote())
      for (const text of parts) event.system.push({ type: "text", text })
    }),
  )

  // ── PreCompact ─────────────────────────────────────────────────────────
  await ctx.session.hook(
    "compaction",
    guard(log, "session.compaction", async (event: any) => {
      const id = String(event.sessionID)
      await withTimeout(
        bridge.dispatch("PreCompact", { ...basePayload("PreCompact", id, directory), trigger: "auto", custom_instructions: "" }, { sessionID: id }),
        PRE_COMPACT_WAIT_MS,
      )
      event.system.push({ type: "text", text: compactionGuidance(ecc.version, [...editedFiles]) })
    }),
  )

  // ── Lifecycle events (Stop, SessionEnd, external file changes) ─────────
  const abort = new AbortController()
  const consume = async () => {
    try {
      const stream = await ctx.event.subscribe({ signal: abort.signal })
      for await (const raw of stream) {
        try {
          handleEvent(raw)
        } catch (error) {
          log("warn", `[ECC] event handler error ignored: ${(error as Error)?.message}`)
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) log("warn", `[ECC] event stream ended: ${(error as Error)?.message ?? String(error)}`)
    }
  }
  const handleEvent = (raw: any) => {
    const type = String(raw?.type ?? "")
    const data = raw?.data ?? {}
    const id = typeof data.sessionID === "string" ? data.sessionID : undefined
    switch (type) {
      case "session.created": {
        const where = data.location?.directory ?? raw.location?.directory
        if (!id || (where && path.resolve(where) !== path.resolve(directory))) return
        const info = session(id)
        if (typeof data.parentID === "string" && data.parentID) info.parentID = data.parentID
        return
      }
      case "session.execution.succeeded": {
        // Execution events carry no location; only act on sessions this
        // instance has seen through its own hooks or a matching created event.
        if (!id || !sessions.has(id)) return
        if (isChild(id) && !childHooks) return
        bridge.dispatchInBackground("Stop", { ...basePayload("Stop", id, directory), stop_hook_active: false }, { sessionID: id })
        return
      }
      case "session.deleted": {
        if (!id || !sessions.has(id)) return
        if (!isChild(id) || childHooks) {
          bridge.dispatchInBackground("SessionEnd", { ...basePayload("SessionEnd", id, directory), reason: "other" }, { sessionID: id })
        }
        sessions.delete(id)
        ledger.clearSession(id)
        return
      }
      case "filesystem.changed": {
        const file = typeof data.file === "string" ? data.file : undefined
        if (!file || !store) return
        const abs = path.isAbsolute(file) ? file : path.resolve(directory, file)
        if (!abs.startsWith(path.resolve(directory) + path.sep)) return
        if (/(^|[/\\])(\.git|node_modules)([/\\]|$)/.test(abs)) return
        store.recordChange(abs, data.event === "unlink" ? "deleted" : data.event === "add" ? "added" : "modified")
        return
      }
    }
  }
  void consume()

  return async () => {
    abort.abort()
    await bridge.drain(DRAIN_ON_DISPOSE_MS)
  }
}

function shellQuote(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

function resourcesFor(calls: readonly ClaudeToolCall[], directory: string): string[] {
  const resources = new Set<string>()
  for (const call of calls) {
    const file = call.tool_input.file_path
    if (typeof file === "string") {
      resources.add(file)
      const rel = path.relative(directory, file)
      if (rel && !rel.startsWith("..")) resources.add(rel.split(path.sep).join("/"))
    }
  }
  return [...resources]
}

function appendContent(result: any, note: string): any {
  const content = result?.content
  if (Array.isArray(content)) return { ...result, content: [...content, { type: "text", text: note }] }
  if (typeof content === "string") return { ...result, content: `${content}\n${note}` }
  const text = contentText(content)
  return { ...result, content: text ? `${text}\n${note}` : note }
}
