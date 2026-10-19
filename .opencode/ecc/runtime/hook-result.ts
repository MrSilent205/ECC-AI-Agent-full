/**
 * Interpret a Claude-Code-style hook result.
 *
 * ECC hooks report decisions in the formats Claude Code understands:
 *   - exit code 2, reason on stderr (blocking error)
 *   - stdout JSON `{ hookSpecificOutput: { permissionDecision: "deny"|"ask", permissionDecisionReason } }`
 *   - stdout JSON `{ decision: "block", reason }`
 *   - stdout JSON `{ hookSpecificOutput: { additionalContext } }` (context for the model)
 * Anything else, including a runner failure, is "no opinion" so the caller
 * fails open. The runner echoes stdin back when a hook is disabled by profile,
 * so stdout that equals the payload is ignored rather than parsed as a result.
 */

import type { HookRunResult } from "./hook-runner.ts"

export type HookDecision = "allow" | "block" | "ask"

export interface InterpretedHookResult {
  readonly decision: HookDecision
  readonly reason?: string
  readonly additionalContext?: string
  /** Plain (non-JSON) stdout, which Claude Code adds as context for prompt/session hooks. */
  readonly plainOutput?: string
  readonly failure?: string
}

const MAX_REASON_CHARS = 2000

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_REASON_CHARS ? trimmed.slice(0, MAX_REASON_CHARS) + "…" : trimmed
}

function parseJsonObject(text: string): Record<string, any> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function interpretHookResult(result: HookRunResult, payloadJson: string): InterpretedHookResult {
  if (result.failure) {
    return { decision: "allow", failure: result.failure }
  }

  const stdout = result.stdout === payloadJson ? "" : result.stdout
  const json = parseJsonObject(stdout)
  const specific = json?.hookSpecificOutput && typeof json.hookSpecificOutput === "object"
    ? json.hookSpecificOutput
    : undefined
  const additionalContext =
    typeof specific?.additionalContext === "string" && specific.additionalContext.trim()
      ? specific.additionalContext
      : undefined

  if (result.exitCode === 2) {
    const reason = clip(result.stderr) || clip(stdout) || "Blocked by an ECC hook"
    return { decision: "block", reason, additionalContext }
  }

  if (specific?.permissionDecision === "deny") {
    return {
      decision: "block",
      reason: clip(String(specific.permissionDecisionReason ?? json?.reason ?? "Blocked by an ECC hook")),
      additionalContext,
    }
  }
  if (json?.decision === "block") {
    return { decision: "block", reason: clip(String(json.reason ?? "Blocked by an ECC hook")), additionalContext }
  }
  if (specific?.permissionDecision === "ask") {
    return { decision: "ask", reason: clip(String(specific.permissionDecisionReason ?? "")), additionalContext }
  }

  const plainOutput = !json && stdout.trim() ? clip(stdout) : undefined
  return { decision: "allow", additionalContext, plainOutput }
}
