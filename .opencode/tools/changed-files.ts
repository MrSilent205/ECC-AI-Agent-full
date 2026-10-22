/**
 * ECC Custom Tool: Changed Files
 *
 * Lists files changed by agents in this session as a navigable tree.
 *
 * Framework-free (OpenCode v2): registered through `ctx.tool.transform` in
 * `plugins/index.ts`. No `@opencode-ai/plugin` import.
 */

import type { ChangeType, TreeNode } from "../plugins/lib/changed-files-store.ts"

export interface ChangedFilesInput {
  filter?: "all" | "added" | "modified" | "deleted"
  format?: "tree" | "json"
}

export const changedFilesDescription =
  "List files changed by agents in this session as a navigable tree. Shows added (+), modified (~), and deleted (-) indicators. Use filter to show only specific change types. Returns paths for git diff."

const INDICATORS: Record<ChangeType, string> = {
  added: "+",
  modified: "~",
  deleted: "-",
}

function renderTree(nodes: TreeNode[], indent: string): string {
  const lines: string[] = []
  for (const node of nodes) {
    const indicator = node.changeType ? ` (${INDICATORS[node.changeType]})` : ""
    const name = node.changeType ? `${node.name}${indicator}` : `${node.name}/`
    lines.push(`${indent}${name}`)
    if (node.children.length > 0) {
      lines.push(renderTree(node.children, `${indent}  `))
    }
  }
  return lines.join("\n")
}

// Loaded lazily (instead of via a top-level import) so that a missing or
// partially-installed `~/.opencode/plugins` directory only breaks this one
// tool when it's actually invoked, rather than throwing during module
// evaluation. `tools/index.ts` re-exports every tool from a single barrel
// file, so a static import failure here previously took down the entire
// tools module -- and with it, the whole OpenCode session -- on the very
// first tool-loading pass (see #2530).
type ChangedFilesStore = typeof import("../plugins/lib/changed-files-store.ts")
let changedFilesStorePromise: Promise<ChangedFilesStore> | undefined

async function loadChangedFilesStore(): Promise<ChangedFilesStore> {
  if (!changedFilesStorePromise) {
    changedFilesStorePromise = import("../plugins/lib/changed-files-store.ts").catch(() => {
      changedFilesStorePromise = undefined
      throw new Error(
        "changed-files tool: could not load the changed-files store. " +
          "This usually means the ~/.opencode/plugins directory is missing or incomplete " +
          "(an interrupted or partial ECC install can leave tools/ populated without plugins/). " +
          "Run `node scripts/repair.js --target opencode` (or `ecc repair --target opencode`) " +
          "from the ECC repo to restore the missing files."
      )
    })
  }
  return changedFilesStorePromise
}

export async function executeChangedFiles(args: ChangedFilesInput, _cwd: string): Promise<string> {
  const { buildTree, getChangedPaths, hasChanges } = await loadChangedFilesStore()
  const filter = args.filter === "all" || !args.filter ? undefined : (args.filter as ChangeType)
  const format = args.format ?? "tree"

  if (!hasChanges()) {
    return JSON.stringify({ changed: false, message: "No files changed in this session" })
  }

  const paths = getChangedPaths(filter)

  if (format === "json") {
    return JSON.stringify(
      {
        changed: true,
        filter: filter ?? "all",
        files: paths.map((p) => ({ path: p.path, changeType: p.changeType })),
        diffCommands: paths
          .filter((p) => p.changeType !== "added")
          .map((p) => `git diff ${p.path}`),
      },
      null,
      2
    )
  }

  const tree = buildTree(filter)
  const treeStr = renderTree(tree, "")
  const diffHint = paths
    .filter((p) => p.changeType !== "added")
    .slice(0, 5)
    .map((p) => `  git diff ${p.path}`)
    .join("\n")

  let output = `Changed files (${paths.length}):\n\n${treeStr}`
  if (diffHint) {
    output += `\n\nTo view diff for a file:\n${diffHint}`
  }
  return output
}

export const changedFiles = {
  description: changedFilesDescription,
  execute: async (rawArgs?: any, context?: any) => {
    const cwd = context?.worktree || context?.directory || process.cwd();
    return executeChangedFiles((rawArgs ?? {}) as any, cwd);
  },
};

