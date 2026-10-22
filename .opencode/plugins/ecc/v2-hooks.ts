/**
 * OpenCode v2 plugin surface.
 *
 * v2 hosts load a module whose default export is `{ id, setup }` where
 * `setup(ctx)` registers hooks on the provided context. The context API is
 * accessed defensively (everything is `any`) so the module stays loadable
 * without the v2 runtime types.
 */

import { createEccRuntime, type EccRuntime, type LogFn } from "./runtime.ts"

const log: LogFn = (level, message) => {
  if (level === "warn") console.warn(message)
  else if (level === "error") console.error(message)
  else if (level === "debug") console.debug(message)
  else console.log(message)
}

export async function setupV2Hooks(ctx: any): Promise<() => void> {
  const locationDir: string =
    (ctx?.location && typeof ctx.location.directory === "string" && ctx.location.directory) ||
    process.cwd()
  const projectDir: string =
    (ctx?.location?.project &&
    typeof ctx.location.project === "object" &&
    typeof ctx.location.project.directory === "string"
      ? ctx.location.project.directory
      : locationDir) || locationDir

  const runtime: EccRuntime = await createEccRuntime({
    projectDir,
    log,
    resolveSessionDir: async (sessionID) => {
      try {
        const info = (await ctx.session.get({ sessionID })) as
          | Record<string, unknown>
          | undefined
        if (info && typeof info === "object") {
          for (const key of ["directory", "worktree", "cwd"]) {
            const value = info[key]
            if (typeof value === "string" && value) return value
          }
        }
      } catch {
        // fall through to the plugin location directory
      }
      return projectDir
    },
  })

  // tool.execute.before
  await ctx.tool.hook("execute.before", async (event: any) => {
    await runtime.toolBefore(event.tool, event.input, event.sessionID, event.id)
  })

  // tool.execute.after — change tracking, format, typecheck + absorbs file.edited
  await ctx.tool.hook("execute.after", async (event: any) => {
    if (event.status !== "completed") return
    await runtime.toolAfter(event.tool, event.input, event.output, event.sessionID, event.id)
  })

  // shell.create.before — environment injection (v1 shell.env)
  await ctx.shell.hook("create.before", (event: any) => {
    event.env = event.env || {}
    runtime.shellEnv(event.cwd, event.env)
  })

  // permission.evaluate — audit + auto-approve safe ops
  await ctx.permission.hook("evaluate", async (event: any) => {
    const action = event.action
    log("info", `[ECC] Permission requested: action=${action}`)

    const decision = runtime.permissionDecision(action, event.resources)
    if (decision.status === "allow" || decision.status === "deny") {
      event.effect = decision.status
      event.message = decision.message
    }
  })

  // compaction hook
  await ctx.session.hook("compaction", (event: any) => {
    if (Array.isArray(event.system)) {
      event.system.push({ type: "text", text: runtime.compactionText() })
    }
  })

  // Register custom tools (changed-files, dependency-analyzer).
  const runners = await runtime.loadToolRunners()
  if (runners) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "changed-files",
        description: runners.changedFilesDescription,
        input: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              enum: ["all", "added", "modified", "deleted"],
              description: "Filter by change type (default: all)",
            },
            format: {
              type: "string",
              enum: ["tree", "json"],
              description: "Output format (default: tree)",
            },
          },
          additionalProperties: false,
        },
        execute: async (raw: unknown) => ({
          content: await runners.executeChangedFiles((raw ?? {}) as any, runtime.projectDir),
        }),
      })
      editor.add({
        name: "dependency-analyzer",
        description: runners.dependencyAnalyzerDescription,
        input: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["all", "outdated", "security", "unused"],
              description: "Type of analysis (default: all)",
            },
            fix: { type: "boolean", description: "Fix automatically" },
            depth: { type: "number", description: "Depth" },
          },
          additionalProperties: false,
        },
        execute: async (raw: unknown) => ({
          content: await runners.executeDependencyAnalyzer((raw ?? {}) as any, runtime.projectDir),
        }),
      })
    })
  }

  // Session lifecycle + filesystem events via server event stream.
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        const evt = raw as unknown as { type?: unknown; data?: unknown }
        if (typeof evt.type !== "string") continue
        const data =
          evt.data && typeof evt.data === "object"
            ? (evt.data as Record<string, unknown>)
            : {}
        try {
          switch (evt.type) {
            case "session.created":
              runtime.onSessionCreated({
                directory: typeof data.directory === "string" ? data.directory : undefined,
              })
              break
            case "session.idle":
              await runtime.onSessionIdle()
              break
            case "session.deleted":
              runtime.onSessionDeleted()
              break
            case "filesystem.changed": {
              const file = data.file
              const kind = data.event
              if (typeof file !== "string" || !file) break
              runtime.onFileChanged(file, typeof kind === "string" ? kind : "change")
              break
            }
            default:
              break
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          log("debug", `[ECC] Event handler error (${evt.type}): ${msg}`)
        }
      }
    } catch {
      // Aborted on unload — expected.
    }
  })()

  log("info", `[ECC] Plugin loaded - profile=${runtime.currentProfile}`)
  return () => {
    controller.abort()
    runtime.dispose()
  }
}
