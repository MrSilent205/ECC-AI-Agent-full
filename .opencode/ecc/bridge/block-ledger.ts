/**
 * Pending ECC permission decisions, bridging `tool.hook("execute.before")` to
 * `permission.hook("evaluate")`.
 *
 * The before-hook knows the tool input (so ECC hooks can judge it) but cannot
 * reject the call visibly; the evaluate hook can deny with a model-visible
 * message but only sees `{sessionID, action, resources}`. A PreToolUse block is
 * recorded here and consumed by the matching evaluation. Entries are cleared
 * when the call finishes (execute.after) and expire after a short TTL, so a
 * stale entry can never deny an unrelated later call.
 */

/**
 * Permission action each v2 built-in asserts (OpenCode 2.0.24
 * core/src/tool/plugin/*): write/patch share "edit", reads go through
 * FileAccess as "read", the rest use their tool name. MCP tools assert their
 * registered `<server>_<tool>` name. Plugin tools assert nothing, so they map
 * to null and are handled separately.
 */
const ACTIONS: Record<string, string> = {
  edit: "edit",
  write: "edit",
  patch: "edit",
  read: "read",
  glob: "glob",
  grep: "grep",
  webfetch: "webfetch",
  websearch: "websearch",
  skill: "skill",
  subagent: "subagent",
  question: "question",
  shell: "shell",
}

export function permissionActionFor(tool: string, mcpServers?: ReadonlySet<string>): string | null {
  if (ACTIONS[tool]) return ACTIONS[tool]
  if (mcpServers) {
    for (const server of mcpServers) {
      if (tool.startsWith(server + "_")) return tool
    }
  }
  return null
}

export interface PendingDecision {
  readonly sessionID: string
  readonly callID: string
  readonly action: string
  /** Absolute and project-relative paths; empty means "any resource". */
  readonly resources: readonly string[]
  readonly effect: "deny" | "ask"
  readonly message: string
}

interface Entry extends PendingDecision {
  readonly expires: number
}

const TTL_MS = 30_000

export class BlockLedger {
  private entries: Entry[] = []

  constructor(private readonly now: () => number = Date.now) {}

  add(decision: PendingDecision): void {
    this.prune()
    this.entries.push({ ...decision, expires: this.now() + TTL_MS })
  }

  /** Remove and return the decision matching an evaluation, if any. */
  take(sessionID: string, action: string, resources: readonly string[]): PendingDecision | undefined {
    this.prune()
    const index = this.entries.findIndex(
      (entry) =>
        entry.sessionID === sessionID &&
        entry.action === action &&
        (entry.resources.length === 0 || resources.some((resource) => entry.resources.includes(resource))),
    )
    if (index === -1) return undefined
    const [entry] = this.entries.splice(index, 1)
    return entry
  }

  clearCall(callID: string): void {
    this.entries = this.entries.filter((entry) => entry.callID !== callID)
  }

  clearSession(sessionID: string): void {
    this.entries = this.entries.filter((entry) => entry.sessionID !== sessionID)
  }

  get size(): number {
    this.prune()
    return this.entries.length
  }

  private prune(): void {
    const now = this.now()
    this.entries = this.entries.filter((entry) => entry.expires > now)
  }
}
