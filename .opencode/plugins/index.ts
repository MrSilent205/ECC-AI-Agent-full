/**
 * ECC Plugin Hooks for OpenCode (framework-free)
 *
 * OpenCode v2-only plugin surface.
 *
 * Default export `{ id, setup }` where `setup(ctx)` registers hooks and
 * tool transforms on the provided context. The context API is accessed
 * defensively so the module stays loadable without the v2 runtime types.
 *
 * No `@opencode-ai/plugin` import, so this module loads in any directory
 * without node_modules.
 *
 * This fork is optimized exclusively for OpenCode. For Claude/Codex use the
 * upstream ECC repository.
 */

import { setupV2Hooks } from "./ecc/v2-hooks.ts"

export default {
  id: "ecc-hooks",
  setup: async (ctx: any) => await setupV2Hooks(ctx),
}
