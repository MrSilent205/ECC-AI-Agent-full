/**
 * Behaviour shared by the v1 and v2 entry points that is not a Claude Code
 * hook: shell environment, ECC instructions, compaction guidance, and the
 * read-only permission auto-approve list.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { MODULE_DIR } from "../runtime/root.ts"

const MAX_INSTRUCTIONS_BYTES = 32 * 1024
const DISABLED_VALUES = new Set(["0", "false", "off", "no", "none", "disabled"])

function isDisabled(value: string | undefined): boolean {
  return value !== undefined && DISABLED_VALUES.has(value.trim().toLowerCase())
}

function hasFile(directory: string, relativePath: string): boolean {
  try {
    return fs.statSync(path.join(directory, relativePath)).isFile()
  } catch {
    return false
  }
}

/**
 * Environment injected into every shell the agent spawns. CLAUDE_PLUGIN_ROOT
 * lets ECC commands that embed the root resolver find their scripts under
 * OpenCode; it never replaces a root the user or another plugin already set.
 */
export function buildShellEnv(
  current: Record<string, string | undefined>,
  options: { directory: string; root: string | null; version: string; env?: NodeJS.ProcessEnv },
): Record<string, string | undefined> {
  const env = options.env ?? process.env
  const profile = env.ECC_HOOK_PROFILE === "minimal" || env.ECC_HOOK_PROFILE === "strict" ? env.ECC_HOOK_PROFILE : "standard"
  const next: Record<string, string | undefined> = {
    ...current,
    ECC_VERSION: options.version,
    ECC_PLUGIN: "true",
    ECC_HOOK_PROFILE: profile,
    ECC_DISABLED_HOOKS: env.ECC_DISABLED_HOOKS || "",
    PROJECT_ROOT: options.directory,
  }

  const lockfiles: Array<[string, string]> = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ]
  const manager = lockfiles.find(([file]) => hasFile(options.directory, file))
  if (manager) next.PACKAGE_MANAGER = manager[1]

  const languages: Array<[string, string]> = [
    ["tsconfig.json", "typescript"],
    ["go.mod", "go"],
    ["pyproject.toml", "python"],
    ["Cargo.toml", "rust"],
    ["Package.swift", "swift"],
  ]
  const detected = languages.filter(([file]) => hasFile(options.directory, file)).map(([, language]) => language)
  if (detected.length > 0) {
    next.DETECTED_LANGUAGES = detected.join(",")
    next.PRIMARY_LANGUAGE = detected[0]
  }

  const rootAlreadySet = Boolean((env.CLAUDE_PLUGIN_ROOT || "").trim() || (current.CLAUDE_PLUGIN_ROOT || "").trim())
  if (options.root && !rootAlreadySet) next.CLAUDE_PLUGIN_ROOT = options.root
  return next
}

/**
 * ECC's consolidated instructions. OpenCode v2 ignores the config
 * `instructions` key, so the plugin injects them into the system prompt.
 * Set ECC_OPENCODE_INSTRUCTIONS=0 to turn this off.
 */
export function readInstructions(env: NodeJS.ProcessEnv = process.env, startDir: string = MODULE_DIR): string | null {
  if (isDisabled(env.ECC_OPENCODE_INSTRUCTIONS)) return null
  const candidates = [
    path.resolve(startDir, "..", "..", "instructions", "INSTRUCTIONS.md"),
    path.resolve(startDir, "..", "..", "..", "instructions", "INSTRUCTIONS.md"),
  ]
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8")
      const text = raw.length > MAX_INSTRUCTIONS_BYTES ? raw.slice(0, MAX_INSTRUCTIONS_BYTES) : raw
      return `<ecc-instructions>\n${text.trim()}\n</ecc-instructions>`
    } catch {
      // Try the next layout.
    }
  }
  return null
}

export function compactionGuidance(version: string, editedFiles: readonly string[]): string {
  const lines = [
    `# ECC context (preserve across compaction) — ECC ${version}`,
    "",
    "Preserve: 1) current task status and progress, 2) key decisions made, 3) files created or modified,",
    "4) remaining work items, 5) security concerns flagged. Discard verbose tool output, intermediate",
    "exploration, and redundant file listings.",
  ]
  if (editedFiles.length > 0) {
    lines.push("", "## Recently edited files", ...editedFiles.map((file) => `- ${file}`))
  }
  return lines.join("\n")
}

/** Added when the session has OpenCode Ensemble's team tools. */
export function ensembleTeammateNote(): string {
  return [
    "<ecc-ensemble>",
    "If you are working as an OpenCode Ensemble teammate, your plain-text replies are not visible to the team.",
    "Report findings and results with team_message (to the lead) and complete claimed tasks with team_tasks_complete,",
    "instead of only putting them in your final response.",
    "</ecc-ensemble>",
  ].join("\n")
}

const READ_ONLY_ACTIONS = new Set(["read", "glob", "grep", "list"])
const FORMATTER_COMMAND = /^(npx )?(@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)\b/
const TEST_COMMAND = /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)\b/

/**
 * Turn an "ask" into "allow" for read-only tools and formatter/test commands.
 * Only ever relaxes an ask: a configured deny is decided before plugins run.
 * Disable with ECC_OPENCODE_AUTO_APPROVE=0.
 */
export function shouldAutoApprove(action: string, resources: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (isDisabled(env.ECC_OPENCODE_AUTO_APPROVE)) return false
  if (READ_ONLY_ACTIONS.has(action)) return true
  if (action === "shell" && resources.length > 0) {
    return resources.every((command) => FORMATTER_COMMAND.test(command.trim()) || TEST_COMMAND.test(command.trim()))
  }
  return false
}
