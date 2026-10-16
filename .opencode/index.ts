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

// Only the default plugin function may be exported: OpenCode's legacy loader
// iterates every module export and throws if any is not a plugin function.
export { default } from "./plugins/index.ts"
