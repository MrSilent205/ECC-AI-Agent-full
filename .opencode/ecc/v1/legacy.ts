/**
 * OpenCode v1 (>= 1.18.29) entry: the same hook bridge behind v1's
 * function-style hooks. OpenCode v2 ignores this and calls `setup` instead.
 *
 * v1 differences handled here: tool names (`bash`, `task`), a throw in
 * `tool.execute.before` is the documented way to block a tool, events arrive
 * through one `event` callback (`session.idle` is Stop), and custom tools need
 * zod shapes from `@opencode-ai/plugin/tool`, which is loaded lazily so a
 * missing package only disables ECC's tools.
 */

import { ECC_TOOLS } from "../tools/index.ts"
import { toZodShape } from "../tools/schema.ts"
import { HookBridge, basePayload } from "../bridge/hook-bridge.ts"
import { toolResponse, translateToolCall, writtenFiles } from "../bridge/translate.ts"
import { buildShellEnv, compactionGuidance, readInstructions, shouldAutoApprove } from "../bridge/shared.ts"
import { resolveEccRoot } from "../runtime/root.ts"

const V1_TOOL_NAMES: Record<string, string> = { bash: "shell", task: "subagent" }

interface V1Input {
  client?: { app?: { log?: (input: unknown) => unknown } }
  directory: string
  worktree?: string
}

async function loadV1Tools(directory: string): Promise<Record<string, unknown>> {
  try {
    const mod: any = await import("@opencode-ai/plugin/tool")
    const tool = mod.tool ?? mod.default?.tool
    if (typeof tool !== "function" || !tool.schema) return {}
    const tools: Record<string, unknown> = {}
    for (const definition of ECC_TOOLS) {
      tools[definition.v1Name] = tool({
        description: definition.description,
        args: toZodShape(definition.args, tool.schema),
        execute: (args: Record<string, unknown>, context: { directory?: string; worktree?: string; sessionID?: string }) =>
          definition.execute(args, {
            directory: context?.directory || directory,
            worktree: context?.worktree || context?.directory || directory,
            sessionID: context?.sessionID,
          }),
      })
    }
    return tools
  } catch {
    return {}
  }
}

export async function v1Server(input: V1Input): Promise<Record<string, unknown>> {
  const directory = input.worktree || input.directory
  const log = (level: "info" | "warn" | "error", message: string) => {
    try {
      void Promise.resolve(input.client?.app?.log?.({ body: { service: "ecc", level, message } })).catch(() => {})
    } catch {
      // Logging must never break the plugin.
    }
  }
  const ecc = resolveEccRoot()
  const tools = await loadV1Tools(directory)
  const instructions = readInstructions()
  const editedFiles = new Set<string>()
  const startContext = new Map<string, string[]>()
  const bridge = ecc.hooksAvailable && ecc.root ? new HookBridge({ root: ecc.root, directory, log }) : null

  const translate = (tool: string, args: unknown) => translateToolCall(V1_TOOL_NAMES[tool] ?? tool, args, { directory })

  return {
    ...(Object.keys(tools).length > 0 ? { tool: tools } : {}),

    "tool.execute.before": async (event: { tool: string; sessionID?: string; callID?: string }, output: { args?: unknown }) => {
      if (!bridge || event.tool.startsWith("team_")) return
      for (const call of translate(event.tool, output?.args)) {
        const result = await bridge.dispatch(
          "PreToolUse",
          { ...basePayload("PreToolUse", event.sessionID, directory), tool_name: call.tool_name, tool_input: call.tool_input, tool_use_id: event.callID },
          { toolName: call.tool_name, sessionID: event.sessionID },
        )
        if (result.decision === "block") {
          throw new Error(`[ECC ${result.hookId ?? "hook"}] ${result.reason || "Blocked by an ECC hook"}`)
        }
      }
    },

    "tool.execute.after": async (
      event: { tool: string; sessionID?: string; callID?: string; args?: unknown },
      output: { output?: string; args?: unknown },
    ) => {
      const calls = translate(event.tool, event.args ?? output?.args)
      for (const file of writtenFiles(calls)) editedFiles.add(file)
      if (!bridge) return
      const notes: string[] = []
      for (const call of calls) {
        const result = await bridge.dispatch(
          "PostToolUse",
          {
            ...basePayload("PostToolUse", event.sessionID, directory),
            tool_name: call.tool_name,
            tool_input: call.tool_input,
            tool_use_id: event.callID,
            tool_response: toolResponse(V1_TOOL_NAMES[event.tool] ?? event.tool, { content: output?.output ?? "" }, call.tool_input.file_path as string | undefined),
          },
          { toolName: call.tool_name, sessionID: event.sessionID },
        )
        notes.push(...result.contexts)
        if (result.decision === "block" && result.reason) notes.push(result.reason)
      }
      if (notes.length > 0 && output && typeof output.output === "string") {
        output.output += "\n" + notes.map((note) => `[ECC] ${note}`).join("\n")
      }
    },

    event: async ({ event }: { event: { type: string; properties?: Record<string, any> } }) => {
      if (!bridge) return
      const id = event.properties?.sessionID ?? event.properties?.info?.id
      if (event.type === "session.created" && id && !event.properties?.info?.parentID) {
        const result = await bridge.dispatch("SessionStart", { ...basePayload("SessionStart", id, directory), source: "startup" }, { sessionID: id })
        startContext.set(id, [...result.contexts])
      } else if (event.type === "session.idle" && id) {
        bridge.dispatchInBackground("Stop", { ...basePayload("Stop", id, directory), stop_hook_active: false }, { sessionID: id })
      } else if (event.type === "session.deleted" && id) {
        startContext.delete(id)
        bridge.dispatchInBackground("SessionEnd", { ...basePayload("SessionEnd", id, directory), reason: "other" }, { sessionID: id })
      }
    },

    "experimental.chat.system.transform": async (event: { sessionID?: string }, output: { system: string[] }) => {
      if (!output || !Array.isArray(output.system)) return
      if (instructions) output.system.push(instructions)
      const context = event?.sessionID ? startContext.get(event.sessionID) : undefined
      if (context?.length) output.system.push(`<ecc-session-context>\n${context.join("\n\n")}\n</ecc-session-context>`)
    },

    "shell.env": async (_event: unknown, output: { env: Record<string, string> }) => {
      output.env = buildShellEnv(output.env ?? {}, { directory, root: ecc.root, version: ecc.version }) as Record<string, string>
    },

    "experimental.session.compacting": async (event: { sessionID: string }, output: { context: string[]; prompt?: string }) => {
      if (bridge) {
        await bridge.dispatch("PreCompact", { ...basePayload("PreCompact", event.sessionID, directory), trigger: "auto", custom_instructions: "" }, { sessionID: event.sessionID })
      }
      const guidance = compactionGuidance(ecc.version, [...editedFiles])
      if (output.prompt !== undefined) output.prompt = `${output.prompt}\n\n${guidance}`
      else output.context = [...(output.context ?? []), guidance]
    },

    "permission.ask": async (event: { tool?: string; type?: string; args?: unknown; pattern?: unknown }) => {
      const tool = V1_TOOL_NAMES[event.tool ?? event.type ?? ""] ?? event.tool ?? event.type ?? ""
      const command = typeof event.args === "string" ? event.args : String((event.args as { command?: unknown })?.command ?? "")
      if (shouldAutoApprove(tool, tool === "shell" ? [command] : [])) return { approved: true }
      return { approved: undefined }
    },

    "chat.message": async (event: { sessionID?: string }, output: { parts?: Array<{ type?: string; text?: string }> }) => {
      if (!bridge || !event?.sessionID) return
      const text = (output?.parts ?? []).filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n")
      await bridge.dispatch("UserPromptSubmit", { ...basePayload("UserPromptSubmit", event.sessionID, directory), prompt: text }, { sessionID: event.sessionID })
    },
  }
}
