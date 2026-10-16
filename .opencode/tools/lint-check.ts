/**
 * ECC Custom Tool: Lint Check
 *
 * Detects the appropriate linter and returns a runnable lint command.
 * Supports cross-platform command generation and error handling.
 *
 * Framework-free (OpenCode v2): registered through `ctx.tool.transform` in
 * `plugins/index.ts`. No `@opencode-ai/plugin` import.
 */

import * as path from "path"
import * as fs from "fs"

type Linter = "biome" | "eslint" | "ruff" | "pylint" | "golangci-lint"

interface LintResult {
  success: boolean
  linter?: Linter
  command?: string
  instructions?: string
  message?: string
  error?: string
}

export interface LintCheckInput {
  target?: string
  fix?: boolean
  linter?: Linter
}

export const lintCheckDescription =
  "Detect linter for a target path and return command for check/fix runs. Supports cross-platform command generation."

export async function executeLintCheck(args: LintCheckInput, cwd: string): Promise<string> {
  try {
    const target = args.target || "."
    const fix = args.fix ?? false
    const detected = args.linter || detectLinter(cwd)

    const command = buildLintCommand(detected, target, fix)
    return JSON.stringify({
      success: true,
      linter: detected,
      command,
      instructions: `Run this command:\n\n${command}`,
      platform: process.platform,
      fixMode: fix,
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return JSON.stringify({
      success: false,
      error: `Failed to detect linter: ${errorMessage}`,
      target: args.target,
    })
  }
}

function detectLinter(cwd: string): Linter {
  // Check for Biome config
  if (fs.existsSync(path.join(cwd, "biome.json")) || fs.existsSync(path.join(cwd, "biome.jsonc"))) {
    return "biome"
  }

  // Check for ESLint config
  const eslintConfigs = [
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    "eslint.config.js",
    "eslint.config.mjs",
  ]
  if (eslintConfigs.some((name) => fs.existsSync(path.join(cwd, name)))) {
    return "eslint"
  }

  // Check for Python linters
  const pyprojectPath = path.join(cwd, "pyproject.toml")
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, "utf-8")
      if (content.includes("ruff")) return "ruff"
      if (content.includes("pylint")) return "pylint"
    } catch {
      // ignore read errors and keep fallback logic
    }
  }

  // Check for Go linter
  if (fs.existsSync(path.join(cwd, ".golangci.yml")) || fs.existsSync(path.join(cwd, ".golangci.yaml"))) {
    return "golangci-lint"
  }

  // Default to ESLint for JavaScript/TypeScript projects
  return "eslint"
}

function buildLintCommand(linter: Linter, target: string, fix: boolean): string {
  // Normalize target path for cross-platform compatibility
  const normalizedTarget = path.normalize(target)
  
  // Build command based on linter and platform
  const commands: Record<Linter, string> = {
    biome: `npx @biomejs/biome lint${fix ? " --write" : ""} ${normalizedTarget}`,
    eslint: `npx eslint${fix ? " --fix" : ""} ${normalizedTarget}`,
    ruff: `ruff check${fix ? " --fix" : ""} ${normalizedTarget}`,
    pylint: `pylint ${normalizedTarget}`,
    "golangci-lint": `golangci-lint run ${normalizedTarget}`,
  }

  return commands[linter]
}

export const lintCheck = {
  description: lintCheckDescription,
  execute: async (rawArgs?: any, context?: any) => {
    const cwd = context?.worktree || context?.directory || process.cwd();
    return executeLintCheck((rawArgs ?? {}) as any, cwd);
  },
};

