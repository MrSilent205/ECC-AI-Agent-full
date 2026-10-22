/**
 * Run Tests Tool
 *
 * Custom OpenCode tool to run test suites with various options.
 * Automatically detects the package manager and test framework.
 *
 * Framework-free (OpenCode v2): the runner is exported as a plain function and
 * registered through `ctx.tool.transform` in `plugins/index.ts`. No
 * `@opencode-ai/plugin` import, so the module loads with no node_modules.
 */

import * as path from "path"
import * as fs from "fs"

export interface RunTestsInput {
  pattern?: string
  coverage?: boolean
  watch?: boolean
  updateSnapshots?: boolean
}

export const runTestsDescription =
  "Run the test suite with optional coverage, watch mode, or specific test patterns. Automatically detects package manager (npm, pnpm, yarn, bun) and test framework."

export async function executeRunTests(args: RunTestsInput, cwd: string): Promise<string> {
  const { pattern, coverage, watch, updateSnapshots } = args

  // Detect package manager
  const packageManager = await detectPackageManager(cwd)

  // Detect test framework
  const testFramework = await detectTestFramework(cwd)

  // Build command
  const cmd: string[] = [packageManager]

  if (packageManager === "npm") {
    cmd.push("run", "test")
  } else {
    cmd.push("test")
  }

  // Add options based on framework
  const testArgs: string[] = []

  if (coverage) {
    testArgs.push("--coverage")
  }

  if (watch) {
    testArgs.push("--watch")
  }

  if (updateSnapshots) {
    testArgs.push("-u")
  }

  if (pattern) {
    if (testFramework === "jest" || testFramework === "vitest") {
      testArgs.push("--testPathPattern", pattern)
    } else {
      testArgs.push(pattern)
    }
  }

  // Add -- separator for npm
  if (testArgs.length > 0) {
    if (packageManager === "npm") {
      cmd.push("--")
    }
    cmd.push(...testArgs)
  }

  const command = cmd.join(" ")

  return JSON.stringify({
    command,
    packageManager,
    testFramework,
    options: {
      pattern: pattern || "all tests",
      coverage: coverage || false,
      watch: watch || false,
      updateSnapshots: updateSnapshots || false,
    },
    instructions: `Run this command to execute tests:\n\n${command}`,
  })
}

async function detectPackageManager(cwd: string): Promise<string> {
  const lockFiles: Record<string, string> = {
    "bun.lockb": "bun",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
  }

  for (const [lockFile, pm] of Object.entries(lockFiles)) {
    if (fs.existsSync(path.join(cwd, lockFile))) {
      return pm
    }
  }

  return "npm"
}

async function detectTestFramework(cwd: string): Promise<string> {
  const packageJsonPath = path.join(cwd, "package.json")

  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      }

      if (deps.vitest) return "vitest"
      if (deps.jest) return "jest"
      if (deps.mocha) return "mocha"
      if (deps.ava) return "ava"
      if (deps.tap) return "tap"
    } catch {
      // Ignore parse errors
    }
  }

  return "unknown"
}

export const runTests = {
  description: runTestsDescription,
  execute: async (rawArgs?: any, context?: any) => {
    const cwd = context?.worktree || context?.directory || process.cwd();
    return executeRunTests((rawArgs ?? {}) as any, cwd);
  },
};

