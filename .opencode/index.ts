/**
 * ECC Plugin for OpenCode
 *
 * Usage via npm:
 * ```json
 * {
 *   "plugin": ["ecc-universal"]
 * }
 * ```
 *
 * For ECC commands, agents, prompts, and instructions, use this repository's
 * `.opencode/opencode.json` as a base or copy the bundled `.opencode/` assets.
 *
 * @packageDocumentation
 */

// Only the default plugin object may be exported: OpenCode iterates every
// module export and expects a plugin object ({ id, setup }), never a bare function.
export { default } from "./plugins/index.ts"
