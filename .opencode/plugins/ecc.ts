/**
 * ECC plugin for OpenCode — one entry for v2 and v1.
 *
 * OpenCode v2 loads `{ id, setup }` (the `@opencode/plugin` contract; its
 * `Plugin.define` is an identity function, so no runtime import is needed).
 * OpenCode v1 (>= 1.18.29) loads `server`. Each host ignores the other's keys.
 *
 * Rules this file must keep:
 *   - It is the ONLY file in `plugins/`. Both hosts load every file there as a
 *     separate plugin, so helpers live under `ecc/`, which neither scans.
 *   - Default export only. v1's loader throws on any export that is not a
 *     plugin, and v2 reads only `default`.
 *   - Plugin ids must be unique: v2 aborts EVERY plugin (including unrelated
 *     ones such as OpenCode Ensemble) on a duplicate id. A global/npm install
 *     uses `ecc`; a project `.opencode/` copy gets a path-derived id, and an
 *     instance guard keeps two copies from both hooking the same directory.
 */

import { createHash } from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { V2Context } from "../ecc/bridge/v2.ts"

const PLUGIN_FILE = fileURLToPath(import.meta.url)
const INSTANCES = Symbol.for("ecc.opencode.instances")

function resolvePluginId(file: string = PLUGIN_FILE): string {
  const segments = file.split(/[\\/]+/)
  if (segments.includes("node_modules")) return "ecc"
  const configRoot = path.basename(path.dirname(path.dirname(file)))
  if (configRoot !== ".opencode") return "ecc"
  return "ecc.project." + createHash("sha256").update(path.dirname(file)).digest("hex").slice(0, 8)
}

function claimInstance(directory: string, id: string): boolean {
  const registry: Map<string, string> = ((globalThis as any)[INSTANCES] ??= new Map<string, string>())
  const key = path.resolve(directory)
  const owner = registry.get(key)
  if (owner && owner !== id) return false
  registry.set(key, id)
  return true
}

function releaseInstance(directory: string, id: string): void {
  const registry: Map<string, string> | undefined = (globalThis as any)[INSTANCES]
  const key = path.resolve(directory)
  if (registry?.get(key) === id) registry.delete(key)
}

const id = resolvePluginId()

function log(level: "info" | "warn" | "error", message: string): void {
  if (level === "info" && !process.env.ECC_OPENCODE_DEBUG) return
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log
  write(message)
}

async function setup(ctx: V2Context): Promise<(() => Promise<void>) | void> {
  const directory = ctx.location.directory
  if (!claimInstance(directory, id)) {
    log("warn", `[ECC] another ECC plugin copy is already active for ${directory}; ${id} stays idle`)
    return
  }
  try {
    const [{ setupV2 }, { resolveEccRoot }] = await Promise.all([
      import("../ecc/bridge/v2.ts"),
      import("../ecc/runtime/root.ts"),
    ])
    const dispose = await setupV2(ctx, resolveEccRoot(), log)
    return async () => {
      try {
        await dispose()
      } finally {
        releaseInstance(directory, id)
      }
    }
  } catch (error) {
    // A broken ECC install must not take OpenCode down with it.
    releaseInstance(directory, id)
    log("error", `[ECC] plugin setup failed; ECC hooks and tools are disabled: ${(error as Error)?.message ?? String(error)}`)
  }
}

async function server(input: Parameters<typeof import("../ecc/v1/legacy.ts").v1Server>[0]) {
  try {
    const { v1Server } = await import("../ecc/v1/legacy.ts")
    return await v1Server(input)
  } catch (error) {
    console.error(`[ECC] plugin setup failed; ECC hooks and tools are disabled: ${(error as Error)?.message ?? String(error)}`)
    return {}
  }
}

export default { id, setup, server }
