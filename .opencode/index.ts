/**
 * ECC Plugin for OpenCode
 *
 * This package provides the published ECC OpenCode plugin module:
 * - Plugin hooks (auto-format, TypeScript check, console.log warning, env injection, etc.)
 * - Custom tools (run-tests, check-coverage, security-audit, format-code, lint-check, git-summary)
 * - Bundled reference config/assets for the wider ECC OpenCode setup
 *
 * Usage:
 *
 * Option 1: Install via npm
 * ```bash
 * npm install ecc-universal
 * ```
 *
 * Then add to your opencode.json:
 * ```json
 * {
 *   "plugin": ["ecc-universal"]
 * }
 * ```
 *
 * That enables the published plugin module only. For ECC commands, agents,
 * prompts, and instructions, use this repository's `.opencode/opencode.json`
 * as a base or copy the bundled `.opencode/` assets into your project.
 *
 * Option 2: Clone and use directly
 * ```bash
 * git clone https://github.com/affaan-m/ECC
 * cd ECC
 * opencode
 * ```
 *
 * @packageDocumentation
 */

// Export the dual-contract plugin definition as the package entry point.
// OpenCode 1.18.29+ reads its `server` (v1 hooks) and OpenCode 2 reads its
// `setup` (v2 hooks); see .opencode/plugins/ecc-hooks.ts. The module
// intentionally exports nothing else: OpenCode 1.x loaders older than 1.18.29
// iterate every export and require the default to be a bare plugin function.
export { ECCHooksPluginDefinition as default } from "./plugins/ecc-hooks.ts"
