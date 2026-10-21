/** List declared dependencies without claiming unperformed audit checks passed. */
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import * as path from "path"
import * as fs from "fs"

const dependencyAnalyzerTool: ToolDefinition = tool({
  description:
    "List dependencies declared in package.json. Security, outdated, unused, transitive-depth analysis, and automatic fixes are unsupported; this tool does not audit packages.",
  args: {
    type: tool.schema.enum(["all", "outdated", "security", "unused"]).optional()
      .describe("Requested analysis (unsupported; only dependency inventory is available)"),
    fix: tool.schema.boolean().optional().describe("Unsupported; no changes are applied"),
    depth: tool.schema.number().optional().describe("Unsupported; only declared dependencies are listed"),
  },
  async execute(args, context): Promise<string> {
    try {
      const cwd = context.worktree || context.directory
      const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
      const dependencies = [
        ["dependencies", "production"],
        ["devDependencies", "development"],
        ["peerDependencies", "peer"],
      ].flatMap(([field, type]) =>
        Object.entries(packageJson[field] || {}).map(([name, current]) => ({ name, current, type }))
      )
      return JSON.stringify({
        success: false,
        status: "unsupported",
        analysisType: args.type ?? "all",
        dependencies: dependencies.slice(0, 50),
        summary: { total: dependencies.length, outdated: null, vulnerable: null, unused: null },
        fixApplied: false,
        recommendations: ["Only declared dependencies were listed. Security, outdated, unused, and transitive checks were not performed. Run your package manager's audit and outdated commands separately."],
      })
    } catch (error: unknown) {
      return JSON.stringify({ success: false, error: `Failed to read dependencies: ${error instanceof Error ? error.message : String(error)}` })
    }
  },
})

export default dependencyAnalyzerTool
