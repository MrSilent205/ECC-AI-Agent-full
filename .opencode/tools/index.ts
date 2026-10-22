/**
 * ECC Custom Tools for OpenCode
 *
 * These tools extend OpenCode with additional capabilities.
 *
 * Framework-free (OpenCode v2): each module also exports a V1-style
 * component (description + execute) for test compatibility and inspection.
 * Run functions (`execute*`) and descriptions (`*Description`) remain
 * available from their individual module files; only the lightweight tool
 * components are aggregated here.
 */

export { changedFiles } from "./changed-files.ts"
export { checkCoverage } from "./check-coverage.ts"
export { securityAudit } from "./security-audit.ts"
export { formatCode } from "./format-code.ts"
export { lintCheck } from "./lint-check.ts"
export { gitSummary } from "./git-summary.ts"
export { runTests } from "./run-tests.ts"
export { dependencyAnalyzer } from "./dependency-analyzer.ts"
