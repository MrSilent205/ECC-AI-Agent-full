/**
 * ECC Plugin Hooks for OpenCode
 *
 * This module is the single entrypoint OpenCode loads, and it satisfies both
 * supported plugin contracts:
 *
 * - OpenCode 1.x (1.18.29 and newer) loads plugins as a `{ id, server }` module
 *   whose `server(input)` returns an object keyed by hook name.
 * - OpenCode 2.x loads plugins as a `{ id, setup(ctx) }` module and registers
 *   hooks through the context surfaces instead.
 *
 * The two contract shapes are not interchangeable, so the implementations live
 * in `lib/v1-hooks.ts` and `lib/v2-hooks.ts` and the default export carries each
 * under the key its loader reads: `{ id, server, setup }`. OpenCode 1.x reads
 * `server` and ignores `setup`; OpenCode 2 reads `setup` and ignores the extra
 * `server` key.
 *
 * Minimum version: OpenCode 1.18.29. That is the first 1.x release whose loader
 * understands an object entrypoint; older 1.x loaders iterate every module
 * export and require a bare function as the default, which an object definition
 * cannot also be.
 *
 * Hook Event Mapping (OpenCode 1 → OpenCode 2):
 * - PreToolUse → tool.execute.before → ctx.tool.hook("execute.before")
 * - PostToolUse → tool.execute.after → ctx.tool.hook("execute.after")
 * - Stop → session.idle → event "session.idle"
 * - SessionStart → session.created → event "session.created"
 * - SessionEnd → session.deleted → event "session.deleted"
 * - shell.env → ctx.shell.hook("create.before")
 * - permission.ask → ctx.permission.hook("evaluate")
 * - experimental.session.compacting → ctx.session.hook("compaction")
 * - file.watcher.updated → event "filesystem.changed"
 * - todo.updated → no OpenCode 2 equivalent (dropped)
 *
 * Version marker (kept in sync with package.json by scripts/release.sh, which
 * rewrites this line on every release):
 *
 * ## Active Plugin: ECC v2.2.3
 */

import { ECCHooksPlugin } from "./lib/v1-hooks.ts"
import { ECCHooksPluginV2 } from "./lib/v2-hooks.ts"

export { ECCHooksPlugin } from "./lib/v1-hooks.ts"
export { ECCHooksPluginV2 } from "./lib/v2-hooks.ts"

/**
 * Dual-contract plugin definition.
 *
 * OpenCode 1.18.29+ reads `id` + `server`; OpenCode 2 reads `id` + `setup` and
 * ignores keys it does not use. A single module can therefore ship both
 * implementations without asking users to pick a version.
 */
export const ECCHooksPluginDefinition = {
  id: "ecc.hooks",
  server: ECCHooksPlugin,
  setup: ECCHooksPluginV2,
}

export default ECCHooksPluginDefinition
