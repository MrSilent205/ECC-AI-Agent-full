/**
 * Permission decisions for the ECC OpenCode runtime.
 *
 * Every bash command is checked against a narrow allowlist; anything unknown,
 * composed, or able to load unreviewed code stays at "ask".
 */

import type { LogFn, PermissionDecision } from "./types.ts"

/** Shell syntax that can chain, substitute, or redirect past an allowlist. */
const UNSAFE_SHELL_SYNTAX = /[;&|`$<>\n\r(){}]/

const FORMATTER_PATTERN =
  /^(npx )?(@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)(\s+[^\s;&|`$<>(){}\\]+)*$/

const TEST_RUNNER_PATTERN =
  /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)(\s+[-A-Za-z0-9_./=:@,+]+)*$/

/**
 * Flags that load or execute code the user never reviewed.
 *
 * `-p` also matches with its value glued to the flag (`pytest -pevil_module`):
 * pytest reads the attached text as a plugin name to import, so the glued form
 * has to be refused exactly like the space-separated one.
 */
const UNSAFE_CODE_LOADING_FLAGS =
  /(?:^|\s)(?:--plugin|--config|--exec|-exec|--require|-r|--setupFiles|--import|--loader)(?:[=\s]|$)|(?:^|\s)-p\S*/

export function asResourceList(resources: string | string[] | undefined | null): string[] {
  if (Array.isArray(resources)) {
    return resources.map((entry) => String(entry))
  }
  if (typeof resources === "string") return resources === "" ? [] : [resources]
  return []
}

const READ_ONLY_ACTIONS = new Set(["read", "glob", "grep", "search", "list"])

/** Validates bash resources against the allowlist; never auto-approves blindly. */
export function checkBashAllowlist(commands: string[], log: LogFn): PermissionDecision {
  // No resource means nothing to validate: never auto-approve.
  if (commands.length === 0 || commands.some((command) => command === "")) {
    log("debug", "[ECC] Bash permission without a command requires user decision")
    return { status: "ask", message: "" }
  }

  // Every resource must independently pass the same allowlist. A single unsafe
  // or unrecognised command keeps the whole request at "ask".
  for (const command of commands) {
    if (UNSAFE_SHELL_SYNTAX.test(command)) {
      log("debug", "[ECC] Bash permission with shell composition requires user decision")
      return { status: "ask", message: "" }
    }
    if (UNSAFE_CODE_LOADING_FLAGS.test(command)) {
      log("debug", "[ECC] Bash permission with a code-loading flag requires user decision")
      return { status: "ask", message: "" }
    }
    if (FORMATTER_PATTERN.test(command) || TEST_RUNNER_PATTERN.test(command)) continue
    log("debug", "[ECC] Bash permission command not allowlisted")
    return { status: "ask", message: "" }
  }

  const isTest = commands.every((command) => TEST_RUNNER_PATTERN.test(command))
  log("debug", isTest ? "[ECC] Auto-approved test execution" : "[ECC] Auto-approved formatter")
  return { status: "allow", message: isTest ? "Test execution" : "Formatter execution" }
}

export function createPermissionHook(
  log: LogFn
): (action: string, resources: string | string[] | undefined | null) => PermissionDecision {
  return (action, resources) => {
    try {
      if (READ_ONLY_ACTIONS.has(action)) {
        log("debug", `[ECC] Auto-approved read-only action: ${action}`)
        return { status: "allow", message: "Read-only operation" }
      }
      if (action !== "bash") {
        log("debug", `[ECC] Permission requires user decision: ${action}`)
        return { status: "ask", message: "" }
      }
      const commands = asResourceList(resources).map((entry) => entry.trim())
      return checkBashAllowlist(commands, log)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("error", `[ECC] Permission handling error for ${action}: ${msg}`)
      return { status: "deny", message: `Error: ${msg}` }
    }
  }
}
