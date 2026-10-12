/**
 * Every ECC OpenCode tool, as adapter-neutral definitions. The v2 entry
 * registers them through `ctx.tool.transform`; the v1 entry wraps them with
 * `@opencode-ai/plugin/tool` when that package is available.
 */

import changedFiles from "./changed-files.ts"
import checkCoverage from "./check-coverage.ts"
import dependencyAnalyzer from "./dependency-analyzer.ts"
import formatCode from "./format-code.ts"
import gitSummary from "./git-summary.ts"
import lintCheck from "./lint-check.ts"
import runTests from "./run-tests.ts"
import securityAudit from "./security-audit.ts"
import type { EccToolDefinition } from "./schema.ts"

export const ECC_TOOLS: readonly EccToolDefinition[] = [
  runTests,
  checkCoverage,
  securityAudit,
  formatCode,
  lintCheck,
  gitSummary,
  changedFiles,
  dependencyAnalyzer,
]
