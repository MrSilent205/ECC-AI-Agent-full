/**
 * OpenCode v1 plugin surface.
 *
 * v1 hosts load a module whose default export is `{ id, server }` where
 * `server(input)` returns the hook object. Hooks are plain functions that
 * receive `(input, output)`; the host mutates `output` to change behaviour.
 *
 * Framework-free on purpose: no `@opencode-ai/plugin` import, so the module
 * loads in any directory without node_modules. The v1 hook contract is
 * re-declared locally (structurally) instead of imported.
 */

import { createEccRuntime, type EccRuntime, type LogFn, type ShellFn } from "./runtime.ts"

const log: LogFn = (level, message) => {
  if (level === "warn") console.warn(message)
  else if (level === "error") console.error(message)
  else if (level === "debug") console.debug(message)
  else console.log(message)
}

/**
 * Load zod for v1 tool argument schemas. zod is resolved at runtime because
 * the plugin must stay loadable in installations without it.
 */
async function loadZod(): Promise<any | undefined> {
  try {
    const specifier: string = "zod"
    const mod = (await import(specifier)) as { z?: any }
    return mod.z ?? undefined
  } catch {
    return undefined
  }
}

function readPattern(permission: any): string {
  const pattern = permission?.pattern
  if (Array.isArray(pattern)) return pattern.join("\n")
  if (typeof pattern === "string") return pattern
  return ""
}

function readSessionDirectory(sessionID: string | undefined, input: any): Promise<string> {
  const client = input?.client
  if (!sessionID || typeof client?.session?.get !== "function") {
    return Promise.resolve(input?.directory ?? input?.worktree ?? process.cwd())
  }
  return Promise.resolve()
    .then(() => client.session.get({ path: { id: sessionID } }))
    .then((raw: any) => {
      const info = raw?.data ?? raw
      for (const key of ["directory", "worktree", "cwd"]) {
        const value = info?.[key]
        if (typeof value === "string" && value) return value
      }
      return input?.directory ?? input?.worktree ?? process.cwd()
    })
    .catch(() => input?.directory ?? input?.worktree ?? process.cwd())
}

export async function createV1Hooks(input: any): Promise<Record<string, unknown>> {
  const directory: string =
    (typeof input?.directory === "string" && input.directory) ||
    (typeof input?.worktree === "string" && input.worktree) ||
    process.cwd()

  const runtime: EccRuntime = await createEccRuntime({
    projectDir: directory,
    log,
    resolveSessionDir: (sessionID) => readSessionDirectory(sessionID, input),
    shell: typeof input?.$ === "function" ? (input.$ as ShellFn) : undefined,
  })

  const tools: Record<string, unknown> = {}
  const runners = await runtime.loadToolRunners()
  if (runners) {
    const z = await loadZod()
    if (z) {
      tools["changed-files"] = {
        description: runners.changedFilesDescription,
        args: {
          filter: z
            .enum(["all", "added", "modified", "deleted"])
            .describe("Filter by change type (default: all)"),
          format: z.enum(["tree", "json"]).describe("Output format (default: tree)"),
        },
        execute: async (args: any) =>
          await runners.executeChangedFiles(args ?? {}, runtime.projectDir),
      }
      tools["dependency-analyzer"] = {
        description: runners.dependencyAnalyzerDescription,
        args: {
          type: z
            .enum(["all", "outdated", "security", "unused"])
            .describe("Type of analysis (default: all)"),
          fix: z.boolean().describe("Fix automatically"),
          depth: z.number().describe("Depth"),
        },
        execute: async (args: any) =>
          await runners.executeDependencyAnalyzer(args ?? {}, runtime.projectDir),
      }
    } else {
      log("warn", "[ECC] Custom tools disabled: zod is not available in this runtime.")
    }
  }

  log("info", `[ECC] Plugin loaded - profile=${runtime.currentProfile}`)

  return {
    tool: tools,

    async event(hookInput: any) {
      const event = hookInput?.event
      if (!event || typeof event.type !== "string") return
      const properties =
        event.properties && typeof event.properties === "object" ? event.properties : {}

      try {
        switch (event.type) {
          case "session.created": {
            const info =
              properties.info && typeof properties.info === "object" ? properties.info : {}
            runtime.onSessionCreated({
              directory: typeof info.directory === "string" ? info.directory : undefined,
            })
            break
          }
          case "session.idle":
            await runtime.onSessionIdle()
            break
          case "session.deleted":
            runtime.onSessionDeleted()
            break
          case "file.watcher.updated": {
            const file = properties.file
            if (typeof file !== "string" || !file) break
            const kind = typeof properties.event === "string" ? properties.event : "change"
            runtime.onFileChanged(file, kind)
            break
          }
          case "file.edited": {
            const file = properties.file
            if (typeof file !== "string" || !file) break
            runtime.onFileChanged(file, "change")
            break
          }
          default:
            break
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log("debug", `[ECC] Event handler error (${event.type}): ${msg}`)
      }
    },

    async "tool.execute.before"(hookInput: any, output: any) {
      await runtime.toolBefore(
        hookInput?.tool,
        output?.args,
        hookInput?.sessionID,
        hookInput?.callID
      )
    },

    async "tool.execute.after"(hookInput: any, output: any) {
      await runtime.toolAfter(
        hookInput?.tool,
        hookInput?.args,
        output?.output,
        hookInput?.sessionID,
        hookInput?.callID
      )
    },

    async "shell.env"(hookInput: any, output: any) {
      runtime.shellEnv(hookInput?.cwd, output?.env)
    },

    async "permission.ask"(permission: any, output: any) {
      const action = typeof permission?.type === "string" ? permission.type : ""
      const decision = runtime.permissionDecision(action, readPattern(permission))
      if (!output) return
      if (decision.status === "allow" || decision.status === "deny") {
        output.status = decision.status
      }
    },

    async "experimental.session.compacting"(hookInput: any, output: any) {
      const text = runtime.compactionText()
      if (Array.isArray(output?.context)) {
        output.context.push(text)
      }
    },

    async dispose() {
      runtime.dispose()
    },
  }
}
