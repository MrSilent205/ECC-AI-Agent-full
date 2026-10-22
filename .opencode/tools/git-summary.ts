/**
 * ECC Custom Tool: Git Summary
 *
 * Returns branch/status/log/diff details for the active repository.
 *
 * Framework-free (OpenCode v2): registered through `ctx.tool.transform` in
 * `plugins/index.ts`. No `@opencode-ai/plugin` import.
 */

import { execFileSync } from "child_process"

export interface GitSummaryInput {
  depth?: number
  includeDiff?: boolean
  baseBranch?: string
}

export const gitSummaryDescription =
  "Generate git summary with branch, status, recent commits, and optional diff stats."

// Conservative subset of git's allowed ref-name characters. Rejects shell
// metacharacters and option-like leading `-` so a model-supplied baseBranch
// cannot inject into the shell command line built below.
const SAFE_GIT_REF = /^[A-Za-z0-9._/-]+$/

function isSafeRef(ref: string): boolean {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 200) return false
  if (!SAFE_GIT_REF.test(ref)) return false
  if (ref.startsWith("-") || ref.startsWith(".") || ref.startsWith("/")) return false
  if (ref.includes("..") || ref.includes("//")) return false
  return true
}

function isSafeDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1000
}

export async function executeGitSummary(args: GitSummaryInput, cwd: string): Promise<string> {
  const depth = isSafeDepth(args.depth) ? args.depth : 5
  const includeDiff = args.includeDiff ?? true
  const baseBranch = args.baseBranch ?? "main"

  const result: Record<string, string> = {
    branch: runArgs(["branch", "--show-current"], cwd) || "unknown",
    status: runArgs(["status", "--short"], cwd) || "clean",
    log: runArgs(["log", "--oneline", `-${depth}`], cwd) || "no commits found",
  }

  if (includeDiff) {
    result.stagedDiff = runArgs(["diff", "--cached", "--stat"], cwd) || ""
    result.branchDiff = isSafeRef(baseBranch)
      ? runArgs(["diff", `${baseBranch}...HEAD`, "--stat"], cwd) ||
        `unable to diff against ${baseBranch}`
      : `unable to diff against ${baseBranch} (invalid ref)`
  }

  return JSON.stringify(result)
}

function runArgs(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch {
    return ""
  }
}

export const gitSummary = {
  description: gitSummaryDescription,
  execute: async (rawArgs?: any, context?: any) => {
    const cwd = context?.worktree || context?.directory || process.cwd();
    return executeGitSummary((rawArgs ?? {}) as any, cwd);
  },
};

