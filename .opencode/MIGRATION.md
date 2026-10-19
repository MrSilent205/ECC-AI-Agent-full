# Migration Guide: Claude Code to OpenCode

This guide helps you migrate from Claude Code to OpenCode while using the ECC configuration.

## Overview

OpenCode is an alternative CLI for AI-assisted development that supports **all** the same features as Claude Code, with some differences in configuration format.

## Key Differences

| Feature | Claude Code | OpenCode | Notes |
|---------|-------------|----------|-------|
| Configuration | `CLAUDE.md`, `plugin.json` | `opencode.json` | Different file formats |
| Agents | Markdown frontmatter | JSON object | Full parity |
| Commands | `commands/*.md` | `command` object or `.md` files | Full parity |
| Skills | `skills/*/SKILL.md` | `skills/` directory | Discovered by OpenCode's skill tool |
| **Hooks** | `hooks.json` | Plugin hooks and events | ECC runs the same hook scripts through its plugin |
| Rules | `rules/*.md` | `AGENTS.md` / plugin-injected instructions | OpenCode v2 ignores the config `instructions` key |
| MCP | Full support | Full support | Full parity |

## Hook Migration

OpenCode v2 (2.0+) plugins are `export default { id, setup(ctx) }` modules
written against `@opencode/plugin`. Do not use `@opencode-ai/plugin`: that
package is the v1 SDK and only contains an outdated preview of the v2 API.
OpenCode v2 refuses v1 function-style plugins ("Plugin must export a default
definition with an id and an effect or setup function").

ECC does not reimplement its hooks for OpenCode. Its plugin translates
OpenCode events into Claude Code hook payloads and runs the shared scripts
from `hooks/hooks.json`, so the same hook IDs, profiles and disable flags apply.

### Hook Event Mapping (OpenCode v2)

| Claude Code Hook | OpenCode v2 | Notes |
|-----------------|-------------|-------|
| `PreToolUse` | `ctx.tool.hook("execute.before")` | Input is mutable; ECC surfaces blocks via a shell command rewrite or `ctx.permission.hook("evaluate")` deny |
| `PostToolUse` | `ctx.tool.hook("execute.after")` | Result is mutable |
| `UserPromptSubmit` | `ctx.session.hook("prompt")` | Cannot cancel the prompt |
| `SessionStart` | first `prompt`/`context` hook per session | Context goes in via `ctx.session.hook("context")` |
| `PreCompact` | `ctx.session.hook("compaction")` | |
| `Stop` | `session.execution.succeeded` event | `session.idle` is deprecated and not published in v2 |
| `SessionEnd` | `session.deleted` event | |
| N/A | `filesystem.changed` event | Replaces v1 `file.edited` / `file.watcher.updated` |
| N/A | `ctx.shell.hook("create.before")` | Replaces v1 `shell.env` |
| N/A | `ctx.permission.hook("evaluate")` | Replaces v1 `permission.ask` |
| N/A | none | v1 `todo.updated` has no v2 equivalent |

Two v2 details matter when writing hooks:

- A promise-API hook that throws fails the whole step instead of rejecting the
  tool call, so wrap callbacks and report blocks through the mechanisms above.
- Every file in a config `plugins/` directory loads as a separate plugin, and a
  duplicate plugin `id` aborts every plugin. Keep one entry file per plugin.

### Writing a v2 hook

```typescript
// <config>/plugins/prettier.ts
import { execFile } from "node:child_process"

export default {
  id: "my-prettier",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", (event) => {
      const file = (event.input as { path?: string })?.path
      if (event.status === "completed" && file && /\.(ts|tsx|js|jsx)$/.test(file)) {
        execFile("npx", ["prettier", "--write", file], { cwd: ctx.location.directory }, () => {})
      }
    })
  },
}
```

### Upgrading from earlier ECC releases

Re-run the installer (`ecc install --target opencode ...`). It removes the
old `plugins/index.ts`, `plugins/ecc-hooks.ts`, `plugins/lib/`, `tools/`,
`index.ts` and `package.json` it installed (files you changed are kept),
installs `plugins/ecc.ts` and `ecc/`, and merges ECC's agents and commands
into your `opencode.json` while removing the old `"./plugins"` entry.
`ecc repair` refuses to migrate the old layout and asks you to re-run the
installer. Then run `opencode service restart`.

Tool names changed to `ecc_run_tests`, `ecc_changed_files`, etc. under
OpenCode v2.

## Migration Steps

### 1. Install OpenCode

```bash
# Install OpenCode CLI
npm install -g opencode
# or
curl -fsSL https://opencode.ai/install | bash
```

### 2. Use the ECC OpenCode Configuration

The `.opencode/` directory in this repository contains the translated configuration:

```
.opencode/
├── opencode.json              # Main configuration
├── plugins/
│   └── ecc.ts                 # The plugin entry (v2 `{ id, setup }` + v1 `server`)
├── ecc/
│   ├── bridge/                # Runs hooks/hooks.json scripts on OpenCode events
│   ├── runtime/               # ECC root lookup and hook runner
│   └── tools/                 # Custom tools (ecc_run_tests, ...)
├── commands/                  # All 23 commands (markdown)
│   ├── plan.md
│   ├── tdd.md
│   └── ... (21 more)
├── prompts/
│   └── agents/                # Agent prompt files (12)
├── instructions/
│   └── INSTRUCTIONS.md        # Consolidated rules
├── package.json               # npm build surface (not installed into a config root)
├── tsconfig.json              # TypeScript config
└── MIGRATION.md               # This file
```

### 3. Run OpenCode

```bash
# In the repository root
opencode

# The configuration is automatically detected from .opencode/opencode.json
```

## Concept Mapping

### Agents

**Claude Code:**
```markdown
---
name: planner
description: Expert planning specialist...
tools: ["Read", "Grep", "Glob"]
model: opus
---

You are an expert planning specialist...
```

**OpenCode:**
```json
{
  "agent": {
    "planner": {
      "description": "Expert planning specialist...",
      "mode": "subagent",
      "model": "anthropic/claude-opus-4-5",
      "prompt": "{file:prompts/agents/planner.txt}",
      "tools": { "read": true, "bash": true }
    }
  }
}
```

### Commands

**Claude Code:**
```markdown
---
name: plan
description: Create implementation plan
---

Create a detailed implementation plan for: {input}
```

**OpenCode (JSON):**
```json
{
  "command": {
    "plan": {
      "description": "Create implementation plan",
      "template": "Create a detailed implementation plan for: $ARGUMENTS",
      "agent": "planner"
    }
  }
}
```

**OpenCode (Markdown - .opencode/commands/plan.md):**
```markdown
---
description: Create implementation plan
agent: planner
---

Create a detailed implementation plan for: $ARGUMENTS
```

### Skills

**Claude Code:** Skills are loaded from `skills/*/SKILL.md` files.

**OpenCode:** Skills live in a `skills/` directory next to the config (or in
`~/.claude/skills` / `~/.agents/skills`) and are discovered by OpenCode's
skill tool; they are not preloaded into the prompt.

### Rules

**Claude Code:** Rules are in separate `rules/*.md` files.

**OpenCode:** OpenCode v2 reads `AGENTS.md` files and ignores the config
`instructions` key. The ECC plugin injects its consolidated
`instructions/INSTRUCTIONS.md` into the system prompt instead.

## Model Mapping

| Claude Code | OpenCode |
|-------------|----------|
| `opus` | `anthropic/claude-opus-4-5` |
| `sonnet` | `anthropic/claude-sonnet-4-5` |
| `haiku` | `anthropic/claude-haiku-4-5` |

## Available Commands

After migration, ALL 23 commands are available:

| Command | Description |
|---------|-------------|
| `/plan` | Create implementation plan |
| `/tdd` | Enforce TDD workflow |
| `/code-review` | Review code changes |
| `/security` | Run security review |
| `/build-fix` | Fix build errors |
| `/e2e` | Generate E2E tests |
| `/refactor-clean` | Remove dead code |
| `/orchestrate` | Multi-agent workflow |
| `/learn` | Extract patterns mid-session |
| `/checkpoint` | Save verification state |
| `/verify` | Run verification loop |
| `/eval` | Run evaluation |
| `/update-docs` | Update documentation |
| `/update-codemaps` | Update codemaps |
| `/test-coverage` | Check test coverage |
| `/setup-pm` | Configure package manager |
| `/go-review` | Go code review |
| `/go-test` | Go TDD workflow |
| `/go-build` | Fix Go build errors |
| `/skill-create` | Generate skills from git history |
| `/instinct-status` | View learned instincts |
| `/instinct-import` | Import instincts |
| `/instinct-export` | Export instincts |
| `/evolve` | Cluster instincts into skills |
| `/promote` | Promote project instincts to global scope |
| `/projects` | List known projects and instinct stats |

## Available Agents

| Agent | Description |
|-------|-------------|
| `planner` | Implementation planning |
| `architect` | System design |
| `code-reviewer` | Code review |
| `security-reviewer` | Security analysis |
| `tdd-guide` | Test-driven development |
| `build-error-resolver` | Fix build errors |
| `e2e-runner` | E2E testing |
| `doc-updater` | Documentation |
| `refactor-cleaner` | Dead code cleanup |
| `go-reviewer` | Go code review |
| `go-build-resolver` | Go build errors |
| `database-reviewer` | Database optimization |

## Plugin Installation

### Option 1: Home install (recommended)

```bash
npx ecc-universal install --target opencode --profile full --enable-hooks
opencode service restart
```

### Option 2: Use ECC Configuration Directly

Run OpenCode inside the repository; `.opencode/` is discovered automatically.

### Option 3: npm package as a plugin

```json
{
  "plugins": ["ecc-universal"]
}
```

This loads only the plugin module (hook bridge and tools). It does not add
ECC's `agent` or `command` entries; use the home install for those.

## Troubleshooting

### Configuration Not Loading

1. Verify `.opencode/opencode.json` exists in the repository root
2. Check JSON syntax is valid: `cat .opencode/opencode.json | jq .`
3. Ensure all referenced prompt files exist

### Plugin Not Loading

1. Run `opencode service restart`; the background service caches plugins.
2. Check `~/.local/share/opencode/log/opencode.log` for `PluginModule.LoadError`
   or `Duplicate plugin ID`.
3. Make sure `plugins/` contains only `ecc.ts` from ECC (no leftover
   `ecc-hooks.ts` or `index.ts`); re-run the installer to clean up.
4. Hooks need `node` on `PATH` or an absolute `ECC_HOOK_NODE`.

### Agent Not Found

1. Check the agent is defined in `opencode.json` under the `agent` object
2. Verify the prompt file path is correct
3. Ensure the prompt file exists at the specified path

### Command Not Working

1. Verify the command is defined in `opencode.json` or as `.md` file in `.opencode/commands/`
2. Check the referenced agent exists
3. Ensure the template uses `$ARGUMENTS` for user input
4. If you installed only `plugins: ["ecc-universal"]`, note that the npm plugin does not add ECC commands or agents to your config

## Best Practices

1. **Start Fresh**: Don't try to run both Claude Code and OpenCode simultaneously
2. **Check Configuration**: Verify `opencode.json` loads without errors
3. **Test Commands**: Run each command once to verify it works
4. **Use Plugins**: Leverage the plugin hooks for automation
5. **Use Agents**: Leverage the specialized agents for their intended purposes

## Reverting to Claude Code

If you need to switch back:

1. Simply run `claude` instead of `opencode`
2. Claude Code will use its own configuration (`CLAUDE.md`, `plugin.json`, etc.)
3. The `.opencode/` directory won't interfere with Claude Code

## Feature Parity Summary

| Feature | Claude Code | OpenCode | Status |
|---------|-------------|----------|--------|
| Agents | PASS: 12 agents | PASS: 12 agents | **Full parity** |
| Commands | PASS: 23 commands | PASS: 23 commands | **Full parity** |
| Skills | PASS: 16 skills | PASS: 16 skills | **Full parity** |
| Hooks | PASS: 3 phases | PASS: 20+ events | **OpenCode has MORE** |
| Rules | PASS: 8 rules | PASS: 8 rules | **Full parity** |
| MCP Servers | PASS: Full | PASS: Full | **Full parity** |
| Custom Tools | PASS: Via hooks | PASS: Native support | **OpenCode is better** |

## Feedback

For issues specific to:
- **OpenCode CLI**: Report to OpenCode's issue tracker
- **ECC Configuration**: Report to [github.com/affaan-m/ECC](https://github.com/affaan-m/ECC)
