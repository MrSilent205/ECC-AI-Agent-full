/**
 * Environment and project detection for the ECC OpenCode runtime.
 *
 * Resolves the ECC root, the plugin version, the optional shell runtime, and
 * the project markers that the shell environment hook exports.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "node:module"

import type { HookProfile, ShellFn, ToolArgs } from "./types.ts"

export const resolvedRuntimeDir = path.dirname(fileURLToPath(import.meta.url))

export function normalizeProfile(value: string | undefined): HookProfile {
  if (value === "minimal" || value === "strict") return value
  return "standard"
}

/** Extract a file path from a tool input object, tolerating shape drift. */
export function getFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const args = input as ToolArgs
  const p = args.filePath ?? args.file_path ?? args.path
  return typeof p === "string" && p.trim() ? p : null
}

export function getCommand(input: unknown): string {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""
  const cmd = (input as ToolArgs).command
  return typeof cmd === "string" ? cmd : ""
}

export function countConsoleLogs(filePath: string): number {
  try {
    const text = fs.readFileSync(filePath, "utf-8")
    const matches = text.match(/console\.log\b/g)
    return matches ? matches.length : 0
  } catch {
    return 0
  }
}

/**
 * Artifacts that identify an ECC root, one per capability this plugin needs.
 * Each probe is the exact artifact the caller is about to use, so detection is
 * layout detection rather than an authenticity control.
 */
export const ECC_ROOT_PROBES = {
  root: [path.join("scripts", "lib", "utils.js")],
  skillTracker: [path.join("scripts", "hooks", "skill-run-tracker.js")],
  resolver: [path.join("scripts", "lib", "resolve-ecc-root.js")],
} as const

export function findEccRootDir(startDir: string, probes: readonly string[]): string | null {
  let current = startDir
  for (let depth = 0; depth < 5; depth += 1) {
    if (probes.every((probe) => fs.existsSync(path.join(current, probe)))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export function getECCVersion(eccRootDir?: string | null): string {
  const candidates = [
    eccRootDir,
    path.resolve(resolvedRuntimeDir, ".."),
    path.resolve(resolvedRuntimeDir, "..", ".."),
    path.resolve(resolvedRuntimeDir, "..", "..", ".."),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf-8"))
      if (typeof packageJson.version === "string" && packageJson.version) {
        return packageJson.version
      }
    } catch {
      // Try the next candidate.
    }
  }
  return "2.0.0"
}

let shellProbed = false
let cachedShell: ShellFn | undefined
export function getShell(): ShellFn | undefined {
  if (!shellProbed) {
    shellProbed = true
    try {
      const require = createRequire(import.meta.url)
      cachedShell = (require("bun") as { $: ShellFn }).$
    } catch {
      cachedShell = undefined
    }
  }
  return cachedShell
}

export function resolvePath(p: string, base: string): string {
  if (path.isAbsolute(p)) return p
  return path.join(base, p)
}

export function hasProjectFile(relativePath: string, base: string): boolean {
  try {
    return fs.statSync(resolvePath(relativePath, base)).isFile()
  } catch {
    return false
  }
}

export function detectPackageManager(base: string, env: Record<string, string>): void {
  const lockfiles: Record<string, string> = {
    "bun.lockb": "bun",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
  }
  for (const [lockfile, pm] of Object.entries(lockfiles)) {
    if (hasProjectFile(lockfile, base)) {
      env.PACKAGE_MANAGER = pm
      return
    }
  }
}

export function detectLanguages(base: string, env: Record<string, string>): void {
  const langDetectors: Record<string, string> = {
    "tsconfig.json": "typescript",
    "go.mod": "go",
    "pyproject.toml": "python",
    "Cargo.toml": "rust",
    "Package.swift": "swift",
  }
  const detected: string[] = []
  for (const [file, lang] of Object.entries(langDetectors)) {
    if (hasProjectFile(file, base)) detected.push(lang)
  }
  if (detected.length > 0) {
    env.DETECTED_LANGUAGES = detected.join(",")
    env.PRIMARY_LANGUAGE = detected[0]
  }
}
