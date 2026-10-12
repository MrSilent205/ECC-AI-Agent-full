/**
 * Adapter-neutral core of the OpenCode hook bridge.
 *
 * Given a Claude Code hook event and payload, run every matching row of the
 * generated hook table (hooks/hooks.json, see scripts/build-opencode-hook-table.js)
 * and fold the results into one decision. The v2 and v1 entry points only
 * translate OpenCode events into calls on this class.
 *
 * Semantics mirror Claude Code:
 *   - Synchronous rows for an event run in parallel and are awaited.
 *   - `async: true` rows are fire-and-forget; their output is ignored. They run
 *     detached, as do all Stop/SessionEnd rows, so `opencode run` exiting
 *     right after a session cannot kill them.
 *   - Any synchronous block wins; otherwise any "ask"; otherwise allow.
 *   - Runner failures and timeouts fail open.
 */

import { appendFileSync } from "node:fs"
import * as path from "node:path"
import { detachHookScript, runHookScript, type HookRunResult } from "../runtime/hook-runner.ts"
import { interpretHookResult, type HookDecision } from "../runtime/hook-result.ts"
import table from "./hook-table.generated.json" with { type: "json" }

export type ClaudeHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "PreCompact"
  | "SessionStart"
  | "Stop"
  | "SessionEnd"

export interface HookRow {
  readonly event: ClaudeHookEvent
  readonly matcher: string
  readonly id: string
  readonly kind: "flags" | "direct" | "dispatcher" | "lifecycle"
  readonly argv: readonly string[]
  readonly async: boolean
  readonly timeoutMs?: number
}

export const HOOK_ROWS: readonly HookRow[] = (table as { rows: HookRow[] }).rows

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Claude Code matcher semantics: empty / `*` matches everything; a plain
 * `A|B` list is an exact (case-insensitive) name match; anything else is an
 * unanchored regular expression.
 */
export function matchesTool(matcher: string, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*" || matcher === ".*") return true
  if (!toolName) return false
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    return matcher.split("|").some((name) => name.toLowerCase() === toolName.toLowerCase())
  }
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    return false
  }
}

export function rowTimeout(row: HookRow): number {
  if (row.timeoutMs) return row.timeoutMs
  if (row.kind === "lifecycle") {
    const budget = Number(row.argv[4])
    if (Number.isFinite(budget) && budget > 0) return budget
  }
  return DEFAULT_TIMEOUT_MS
}

export interface DispatchResult {
  readonly decision: HookDecision
  readonly reason?: string
  /** Hook id responsible for the decision, for user-facing messages. */
  readonly hookId?: string
  readonly contexts: readonly string[]
}

export interface HookBridgeOptions {
  readonly root: string
  readonly directory: string
  readonly rows?: readonly HookRow[]
  readonly log?: (level: "info" | "warn" | "error", message: string) => void
  /** Injected for tests. */
  readonly runner?: typeof runHookScript
  readonly detachedRunner?: typeof detachHookScript
  readonly env?: NodeJS.ProcessEnv
}

export class HookBridge {
  readonly root: string
  readonly directory: string
  private readonly rows: readonly HookRow[]
  private readonly runner: typeof runHookScript
  private readonly detachedRunner: typeof detachHookScript
  private readonly log: NonNullable<HookBridgeOptions["log"]>
  private readonly baseEnv: NodeJS.ProcessEnv
  private readonly tracePath: string | undefined
  private readonly pending = new Set<Promise<unknown>>()

  constructor(options: HookBridgeOptions) {
    this.root = options.root
    this.directory = options.directory
    this.rows = options.rows ?? HOOK_ROWS
    this.runner = options.runner ?? runHookScript
    this.detachedRunner = options.detachedRunner ?? detachHookScript
    this.log = options.log ?? (() => {})
    this.baseEnv = options.env ?? process.env
    const trace = this.baseEnv.ECC_OPENCODE_BRIDGE_TRACE?.trim()
    this.tracePath = trace ? path.resolve(trace) : undefined
  }

  rowsFor(event: ClaudeHookEvent, toolName?: string): HookRow[] {
    const toolEvent = event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure"
    return this.rows.filter((row) => row.event === event && (!toolEvent || matchesTool(row.matcher, toolName)))
  }

  hookEnv(sessionID: string | undefined): NodeJS.ProcessEnv {
    return {
      ...this.baseEnv,
      CLAUDE_PLUGIN_ROOT: this.root,
      ECC_PLUGIN_ROOT: this.root,
      CLAUDE_PROJECT_DIR: this.directory,
      ECC_HOOK_HARNESS: "opencode",
      ...(sessionID ? { CLAUDE_SESSION_ID: sessionID, ECC_SESSION_ID: sessionID } : {}),
    }
  }

  private trace(entry: Record<string, unknown>): void {
    if (!this.tracePath) return
    try {
      appendFileSync(this.tracePath, JSON.stringify({ t: Date.now(), ...entry }) + "\n")
    } catch {
      // Tracing is diagnostic only.
    }
  }

  private runRow(row: HookRow, payload: Record<string, unknown>, sessionID: string | undefined, detach: boolean): Promise<HookRunResult> {
    return (detach ? this.detachedRunner : this.runner)(this.root, {
      script: row.argv[0],
      args: row.argv.slice(1),
      payload,
      cwd: this.directory,
      env: this.hookEnv(sessionID),
      timeoutMs: rowTimeout(row),
    })
  }

  /**
   * Run every row matching `event` (and `toolName` for tool events).
   * Never rejects.
   */
  async dispatch(
    event: ClaudeHookEvent,
    payload: Record<string, unknown>,
    options: { toolName?: string; sessionID?: string; detachAll?: boolean } = {},
  ): Promise<DispatchResult> {
    const rows = this.rowsFor(event, options.toolName)
    if (rows.length === 0) return { decision: "allow", contexts: [] }
    const payloadJson = JSON.stringify(payload)
    const contexts: string[] = []
    let block: { reason?: string; hookId: string } | undefined
    let ask: { reason?: string; hookId: string } | undefined

    const syncRuns: Promise<void>[] = []
    for (const row of rows) {
      const detach = row.async || options.detachAll === true
      const run = this.runRow(row, payload, options.sessionID, detach).then(
        (result) => {
          const interpreted = interpretHookResult(result, payloadJson)
          this.trace({ event, hookId: row.id, tool: options.toolName, decision: detach ? "detached" : interpreted.decision, exitCode: result.exitCode, async: row.async, failure: interpreted.failure })
          if (interpreted.failure) {
            this.log("warn", `[ECC] hook ${row.id} failed open: ${interpreted.failure}`)
          }
          return interpreted
        },
        (error) => {
          this.log("warn", `[ECC] hook ${row.id} failed open: ${String(error)}`)
          return null
        },
      )
      if (detach) {
        this.track(run)
        continue
      }
      syncRuns.push(
        run.then((interpreted) => {
          if (!interpreted) return
          if (interpreted.additionalContext) contexts.push(interpreted.additionalContext)
          if ((event === "SessionStart" || event === "UserPromptSubmit") && interpreted.plainOutput) {
            contexts.push(interpreted.plainOutput)
          }
          if (interpreted.decision === "block" && !block) block = { reason: interpreted.reason, hookId: row.id }
          if (interpreted.decision === "ask" && !ask) ask = { reason: interpreted.reason, hookId: row.id }
        }),
      )
    }
    await Promise.all(syncRuns)

    if (block) return { decision: "block", reason: block.reason, hookId: block.hookId, contexts }
    if (ask) return { decision: "ask", reason: ask.reason, hookId: ask.hookId, contexts }
    return { decision: "allow", contexts }
  }

  /** Fire-and-forget dispatch whose completion is still awaited on shutdown. */
  dispatchInBackground(event: ClaudeHookEvent, payload: Record<string, unknown>, options: { toolName?: string; sessionID?: string } = {}): void {
    this.track(this.dispatch(event, payload, { ...options, detachAll: true }))
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => {}).finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
  }

  /** Wait (bounded) for background hooks, e.g. Stop hooks before `opencode run` exits. */
  async drain(timeoutMs = 10_000): Promise<void> {
    if (this.pending.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }
}

/** Fields every Claude Code hook payload carries. */
export function basePayload(event: ClaudeHookEvent, sessionID: string | undefined, directory: string): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: sessionID ?? "",
    transcript_path: "",
    cwd: directory,
    permission_mode: "default",
  }
}
