/**
 * Locate the ECC root that holds the shared hook scripts.
 *
 * This module ships in three layouts, so the number of levels back to the root
 * is not fixed:
 *   - `<config>/ecc/runtime`            (home install into ~/.config/opencode)
 *   - `<repo>/.opencode/ecc/runtime`     (repo checkout)
 *   - `<pkg>/.opencode/dist/ecc/runtime` (compiled npm package)
 * Probing for the exact artifacts the caller is about to use beats a hardcoded
 * `..`: a wrong root would make every hook resolve against a directory that
 * has no scripts. The walk is bounded so it cannot wander into unrelated
 * ancestors.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_DEPTH = 6

export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Shared library every ECC script requires. */
const ROOT_PROBE = path.join("scripts", "lib", "utils.js")
/** ECC's universal hook runner, which applies profile and disable flags. */
export const HOOK_RUNNER_REL = path.join("scripts", "hooks", "run-with-flags.js")

export function findAncestorWith(startDir: string, probes: readonly string[]): string | null {
  let current = startDir
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (probes.every((probe) => fs.existsSync(path.join(current, probe)))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export interface EccRoot {
  /** Directory containing `scripts/lib`, or null when ECC scripts are absent. */
  readonly root: string | null
  /** True when the shared hook runner is installed (hooks-runtime module). */
  readonly hooksAvailable: boolean
  readonly version: string
}

export function readEccVersion(root: string | null, startDir: string = MODULE_DIR): string {
  const candidates: string[] = []
  if (root) candidates.push(path.join(root, "VERSION"), path.join(root, "package.json"))
  // Walk up from this module for a package.json naming ECC (repo or npm layout).
  let current = startDir
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    candidates.push(path.join(current, "package.json"))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8")
      if (candidate.endsWith("VERSION")) {
        const version = raw.trim()
        if (/^\d+\.\d+\.\d+/.test(version)) return version
        continue
      }
      const pkg = JSON.parse(raw)
      if (pkg?.name === "ecc-universal" && typeof pkg.version === "string" && pkg.version) {
        return pkg.version
      }
    } catch {
      // Try the next candidate.
    }
  }
  return "unknown"
}

export function resolveEccRoot(startDir: string = MODULE_DIR): EccRoot {
  const root = findAncestorWith(startDir, [ROOT_PROBE])
  const hooksAvailable = Boolean(root && fs.existsSync(path.join(root, HOOK_RUNNER_REL)))
  return { root, hooksAvailable, version: readEccVersion(root, startDir) }
}
