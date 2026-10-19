/**
 * Translate OpenCode v2 tool calls into the Claude Code tool vocabulary that
 * ECC's hook scripts match on (`tool_name` + `tool_input`).
 *
 * v2 built-ins (verified against OpenCode 2.0.24 core/src/tool/plugin/*):
 *   shell {command, workdir?, timeout?, background?}
 *   edit  {path, oldString, newString, replaceAll?}
 *   write {path, content}
 *   patch {patchText}            (apply_patch envelope, may touch many files)
 *   read  {path, ...}, glob {pattern, path?}, grep {pattern, path?, ...}
 *   skill {id}, subagent {agent, description, prompt}
 *   webfetch, websearch, question
 * MCP tools are registered as `<server>_<tool>` (core/src/tool/mcp.ts).
 */

import * as path from "node:path"

export interface ClaudeToolCall {
  readonly tool_name: string
  readonly tool_input: Record<string, unknown>
}

const BUILTIN_NAMES: Record<string, string> = {
  shell: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  skill: "Skill",
  subagent: "Task",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  question: "AskUserQuestion",
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

export function absolutePath(directory: string, file: string | undefined): string | undefined {
  if (!file) return undefined
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(directory, file)
}

interface PatchFile {
  readonly action: "add" | "update" | "delete"
  readonly file: string
  readonly moveTo?: string
  readonly lines: string[]
}

/** Parse the `*** Begin Patch` envelope used by the v2 `patch` tool. */
export function parsePatch(patchText: string): PatchFile[] {
  const files: PatchFile[] = []
  let current: PatchFile | null = null
  for (const line of patchText.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      current = { action: header[1].toLowerCase() as PatchFile["action"], file: header[2].trim(), lines: [] }
      files.push(current)
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move && current) {
      ;(current as { moveTo?: string }).moveTo = move[1].trim()
      continue
    }
    if (line.startsWith("*** ")) {
      if (line.startsWith("*** End Patch")) current = null
      continue
    }
    current?.lines.push(line)
  }
  return files
}

function patchToCalls(directory: string, patchText: string): ClaudeToolCall[] {
  const calls: ClaudeToolCall[] = []
  for (const file of parsePatch(patchText)) {
    const filePath = absolutePath(directory, file.moveTo ?? file.file) as string
    if (file.action === "add") {
      const content = file.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n")
      calls.push({ tool_name: "Write", tool_input: { file_path: filePath, content } })
      continue
    }
    if (file.action === "delete") {
      // Claude Code has no delete tool; report it as a Bash rm so command
      // guards (e.g. destructive-command checks) still see it.
      calls.push({ tool_name: "Bash", tool_input: { command: `rm ${JSON.stringify(filePath)}` } })
      continue
    }
    const edits: Array<{ old_string: string; new_string: string }> = []
    let oldLines: string[] = []
    let newLines: string[] = []
    const flush = () => {
      if (oldLines.length || newLines.length) {
        edits.push({ old_string: oldLines.join("\n"), new_string: newLines.join("\n") })
      }
      oldLines = []
      newLines = []
    }
    for (const line of file.lines) {
      if (line.startsWith("@@")) {
        flush()
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1))
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1))
      } else {
        const context = line.startsWith(" ") ? line.slice(1) : line
        oldLines.push(context)
        newLines.push(context)
      }
    }
    flush()
    calls.push({ tool_name: "MultiEdit", tool_input: { file_path: filePath, edits } })
  }
  return calls
}

export interface TranslateOptions {
  readonly directory: string
  /** Sanitized MCP server namespaces (`server.replace(/[^a-zA-Z0-9_-]/g, "_")`). */
  readonly mcpServers?: ReadonlySet<string>
}

export function mcpName(tool: string, mcpServers: ReadonlySet<string> | undefined): string | null {
  if (!mcpServers) return null
  // Longest namespace first, so `foo_bar` wins over `foo` for `foo_bar_tool`.
  const candidates = [...mcpServers].sort((a, b) => b.length - a.length)
  for (const server of candidates) {
    if (tool.startsWith(server + "_") && tool.length > server.length + 1) {
      return `mcp__${server}__${tool.slice(server.length + 1)}`
    }
  }
  return null
}

/**
 * Translate one v2 tool call. Returns zero or more Claude calls: `patch` can
 * touch several files, and `execute` (code mode) is skipped because every
 * inner tool call fires its own hook.
 */
export function translateToolCall(tool: string, input: unknown, options: TranslateOptions): ClaudeToolCall[] {
  const args = asRecord(input)
  const { directory } = options
  switch (tool) {
    case "execute":
      return []
    case "shell":
      return [
        {
          tool_name: "Bash",
          tool_input: {
            command: str(args.command) ?? "",
            ...(str(args.workdir) ? { cwd: absolutePath(directory, str(args.workdir)) } : {}),
            ...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
            ...(args.background === true ? { run_in_background: true } : {}),
          },
        },
      ]
    case "edit":
      return [
        {
          tool_name: "Edit",
          tool_input: {
            file_path: absolutePath(directory, str(args.path) ?? str(args.filePath)),
            old_string: typeof args.oldString === "string" ? args.oldString : "",
            new_string: typeof args.newString === "string" ? args.newString : "",
            replace_all: args.replaceAll === true,
          },
        },
      ]
    case "write":
      return [
        {
          tool_name: "Write",
          tool_input: {
            file_path: absolutePath(directory, str(args.path) ?? str(args.filePath)),
            content: typeof args.content === "string" ? args.content : "",
          },
        },
      ]
    case "patch":
      return patchToCalls(directory, typeof args.patchText === "string" ? args.patchText : "")
    case "read":
      return [{ tool_name: "Read", tool_input: { ...args, file_path: absolutePath(directory, str(args.path) ?? str(args.filePath)) } }]
    case "glob":
    case "grep":
      return [
        {
          tool_name: BUILTIN_NAMES[tool],
          tool_input: { ...args, ...(str(args.path) ? { path: absolutePath(directory, str(args.path)) } : {}) },
        },
      ]
    case "skill":
      return [{ tool_name: "Skill", tool_input: { ...args, skill: str(args.id) ?? str(args.name) ?? "" } }]
    case "subagent":
      return [
        {
          tool_name: "Task",
          tool_input: { subagent_type: str(args.agent) ?? "", description: args.description ?? "", prompt: args.prompt ?? "" },
        },
      ]
    default: {
      if (BUILTIN_NAMES[tool]) return [{ tool_name: BUILTIN_NAMES[tool], tool_input: args }]
      const mcp = mcpName(tool, options.mcpServers)
      return [{ tool_name: mcp ?? tool, tool_input: args }]
    }
  }
}

/** File paths a translated call writes, for changed-files tracking. */
export function writtenFiles(calls: readonly ClaudeToolCall[]): string[] {
  const files: string[] = []
  for (const call of calls) {
    if (["Edit", "Write", "MultiEdit"].includes(call.tool_name) && typeof call.tool_input.file_path === "string") {
      files.push(call.tool_input.file_path)
    }
  }
  return files
}

/** Claude-style `tool_response` for PostToolUse, from a v2 `execute.after` result. */
export function toolResponse(tool: string, result: unknown, filePath?: string): Record<string, unknown> {
  const record = asRecord(result)
  const output = asRecord(record.output)
  const text = contentText(record.content)
  if (tool === "shell") {
    return {
      stdout: typeof output.output === "string" ? output.output : text,
      stderr: "",
      exit_code: typeof output.exit === "number" ? output.exit : 0,
      interrupted: false,
    }
  }
  if (filePath) return { filePath, success: true }
  return { output: text }
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}
