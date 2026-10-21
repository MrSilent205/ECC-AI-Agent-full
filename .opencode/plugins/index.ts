/**
 * ECC Plugin Hooks for OpenCode (framework-free)
 *
 * One module, two host surfaces:
 *
 *   v1 host  default export `{ id, server }` — `server(input)` returns the hook
 *            object; hooks are `(input, output)` functions that mutate `output`.
 *   v2 host  default export `{ id, setup }`  — `setup(ctx)` registers hooks and
 *            tool transforms on the provided context.
 *
 * A single default export can carry both keys: a v1 host only reads
 * `id`/`server`/`tui`, a v2 host only reads `id`/`setup`/`effect`, and the
 * foreign key is ignored. Both surfaces share one runtime
 * (`./ecc/runtime.ts`) so behaviour stays identical across hosts.
 *
 * No `@opencode-ai/plugin` import, so this module loads in any directory
 * without node_modules.
 *
 * Hook mapping (v1 name ← v2 registration):
 *
 *   tool.execute.before           ctx.tool.hook("execute.before", ...)
 *   tool.execute.after            ctx.tool.hook("execute.after", ...)
 *   file.edited / file.watcher.updated   event stream (filesystem.changed)
 *   session.created/idle/deleted  ctx.event.subscribe() filtered by type
 *   shell.env                     ctx.shell.hook("create.before", ...)
 *   experimental.session.compacting ctx.session.hook("compaction", ...)
 *   permission.ask                ctx.permission.hook("evaluate", ...)
 *   tool map                      ctx.tool.transform(editor.add(...))
 */

import { createV1Hooks } from "./ecc/v1-hooks.ts"
import { setupV2Hooks } from "./ecc/v2-hooks.ts"

export default {
  id: "ecc-hooks",
  server: async (input: any) => await createV1Hooks(input),
  setup: async (ctx: any) => await setupV2Hooks(ctx),
}
