/**
 * ECC Plugin for OpenCode
 *
 * This package provides the published ECC OpenCode plugin module, loadable by
 * OpenCode v2 (`{ id, setup }`) and v1 >= 1.18.29 (`server`):
 * - A hook bridge that runs ECC's shared Claude Code hook scripts
 *   (hooks/hooks.json) on OpenCode tool, prompt, session and compaction events
 * - Custom tools (ecc_run_tests, ecc_check_coverage, ecc_security_audit,
 *   ecc_format_code, ecc_lint_check, ecc_git_summary, ecc_changed_files,
 *   ecc_dependency_analyzer)
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
 *   "plugins": ["ecc-universal"]
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

// Only the default export: OpenCode v1's loader throws on any export that is
// not a plugin, and v2 reads only `default`.
export { default } from "./plugins/ecc.ts"
