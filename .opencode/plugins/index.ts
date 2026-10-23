/**
 * ECC Plugins for OpenCode
 *
 * Barrel module for the ECC hook plugin. OpenCode treats every file in
 * `plugins/` as a plugin, so this file is a plugin definition too: it
 * deliberately registers nothing and uses its own id. Re-exporting the hooks as
 * this module's default would register them a second time, and OpenCode 2
 * rejects duplicate plugin ids during activation.
 */

export { ECCHooksPlugin, ECCHooksPluginV2, ECCHooksPluginDefinition } from "./ecc-hooks.ts"

const INERT_PLUGIN = async () => ({})

/**
 * Valid on both supported contracts: OpenCode 1.15+ reads `server`, OpenCode 2
 * reads `setup`. Neither registers a hook or touches the filesystem.
 */
export default {
  id: "ecc.index",
  server: INERT_PLUGIN,
  setup: () => {},
}
