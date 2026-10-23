# OpenCode ECC Plugin

> WARNING: This README is specific to OpenCode usage.
> If you installed ECC via npm (e.g. `npm install opencode-ecc`), refer to the root README instead.

ECC plugin for OpenCode - agents, commands, hooks, and skills.

## Installation

## Installation Overview

There are two ways to use ECC:

1. **npm package (recommended for most users)**
   Install via npm/bun/yarn and use the `ecc-install` CLI to set up rules and agents.

2. **Direct clone / plugin mode**
   Clone the repository and run OpenCode directly inside it.

Choose the method that matches your workflow below.

### Option 1: npm Package

```bash
npm install ecc-universal
```

Add to your `opencode.json`:

```json
{
  "plugin": ["ecc-universal"]
}
```

OpenCode 2 reads the `plugins` key instead (an array of packages or
`{ "package": "ecc-universal" }` entries) and also auto-discovers
`.opencode/plugins/`. The published module exports one definition that satisfies
both contracts, so the same package works on either version.

This loads the ECC OpenCode plugin module from npm:
- hook/event integrations

On OpenCode 1.18.29+ the plugin registers two tools (`changed-files` and
`dependency-analyzer`). On OpenCode 2 the plugin registers no custom tools. The
tool surface comes from the `.opencode/tools/*.ts` files that OpenCode discovers
itself, so a project that installs only the npm package does not get them on
OpenCode 2; copy the tools or use one of the setup paths below for the full
catalog.

It does **not** auto-register the full ECC command/agent/instruction catalog in your project config. For the full OpenCode setup, either:
- run OpenCode inside this repository, or
- copy the relevant `.opencode/commands/`, `.opencode/prompts/`, `.opencode/instructions/`, and the `instructions`, `agent`, and `command` config entries into your own project

After installation, the `ecc-install` CLI is also available:

```bash
npx ecc-universal install typescript
```

### Option 2: Direct Use

Clone and run OpenCode in the repository:

```bash
git clone https://github.com/affaan-m/ECC
cd ECC
opencode
```

If you also want to apply the ECC home install
(`node scripts/install-apply.js --target opencode --profile full`), build the
plugin first so the compiled payload at `.opencode/dist/` exists:

```bash
node scripts/build-opencode.js   # or: npm run build:opencode
node scripts/install-apply.js --target opencode --profile full
```

Without `.opencode/dist/index.js`, OpenCode will detect the slash commands
but silently skip plugin hooks and tools. The installer now fails fast with
a pointer to this command if the build step is missing.

## OpenCode Compatibility

The plugin ships a single definition, `{ id, server, setup }`, that both plugin
loaders understand:

- **OpenCode 1.18.29 and newer** reads `server`, the `(input) => hooks` function
  whose result is keyed by the event names in the hooks table below. 1.18.29 is
  the first 1.x release whose loader understands an object entrypoint.
- **OpenCode 2.x** reads `setup(ctx)` and registers the same behavior on the
  context surfaces (`shell`, `tool`, `permission`, `session`, `event`).
- **OpenCode older than 1.18.29 is not supported.** Those loaders iterate every
  module export and require a bare function as the default, which the definition
  object cannot also be.

OpenCode loads every file under `.opencode/plugins/` independently and rejects
duplicate plugin ids at activation, so each file exports its own `id`
(`ecc.hooks` for the hooks, `ecc.index` for the barrel).

## Features

### Agents (26)

| Agent | Description |
|-------|-------------|
| build | Primary coding agent for development work |
| planner | Implementation planning |
| architect | System design |
| code-reviewer | Code review |
| security-reviewer | Security analysis |
| tdd-guide | Test-driven development |
| build-error-resolver | Build error fixes |
| e2e-runner | E2E testing |
| doc-updater | Documentation |
| refactor-cleaner | Dead code cleanup |
| go-reviewer | Go code review |
| go-build-resolver | Go build errors |
| database-reviewer | Database optimization |
| docs-lookup | Documentation lookup via Context7 |
| harness-optimizer | Harness config tuning |
| java-reviewer | Java code review |
| java-build-resolver | Java build errors |
| kotlin-reviewer | Kotlin code review |
| kotlin-build-resolver | Kotlin build errors |
| loop-operator | Autonomous loop execution |
| php-reviewer | PHP code review |
| python-reviewer | Python code review |
| rust-reviewer | Rust code review |
| rust-build-resolver | Rust build errors |
| cpp-reviewer | C++ code review |
| cpp-build-resolver | C++ build errors |

### Commands (26)

| Command | Description |
|---------|-------------|
| `/plan` | Create implementation plan |
| `/tdd` | TDD workflow |
| `/code-review` | Review code changes |
| `/security` | Security review |
| `/build-fix` | Fix build errors |
| `/e2e` | E2E tests |
| `/refactor-clean` | Remove dead code |
| `/orchestrate` | Multi-agent workflow |
| `/learn` | Extract patterns |
| `/checkpoint` | Save progress |
| `/verify` | Verification loop |
| `/eval` | Evaluation |
| `/update-docs` | Update docs |
| `/update-codemaps` | Update codemaps |
| `/test-coverage` | Coverage analysis |
| `/setup-pm` | Package manager |
| `/go-review` | Go code review |
| `/go-test` | Go TDD |
| `/go-build` | Go build fix |
| `/skill-create` | Generate skills |
| `/instinct-status` | View instincts |
| `/instinct-import` | Import instincts |
| `/instinct-export` | Export instincts |
| `/evolve` | Cluster instincts |
| `/promote` | Promote project instincts |
| `/projects` | List known projects |

### Plugin Hooks

| Hook | OpenCode 1 event | OpenCode 2 registration | Purpose |
|------|------------------|--------------------------|---------|
| Prettier | `file.edited` | event `file.edited` | Auto-format JS/TS |
| TypeScript | `tool.execute.after` | `ctx.tool.hook("execute.after")` | Check for type errors |
| console.log | `file.edited` | event `file.edited` | Warn about debug statements |
| Notification | `session.idle` | event `session.idle` | Desktop notification (cross-platform) |
| Git Push Reminder | `tool.execute.before` | `ctx.tool.hook("execute.before")` | Remind to review before pushing |
| Doc File Warning | `tool.execute.before` | `ctx.tool.hook("execute.before")` | Warn about unnecessary documentation |
| Long Command Reminder | `tool.execute.before` | `ctx.tool.hook("execute.before")` | Remind about long-running commands |
| Session Context | `session.created` | event `session.created` | Load project context |
| Console Log Audit | `session.idle` | event `session.idle` | Audit edited files for console.log |
| File Watcher | `file.watcher.updated` | event `filesystem.changed` | Track file system changes |
| Todo Progress | `todo.updated` | — (no OpenCode 2 equivalent) | Log task completion progress |
| Shell Environment | `shell.env` | `ctx.shell.hook("create.before")` | Inject environment variables |
| Session Compacting | `experimental.session.compacting` | `ctx.session.hook("compaction")` | Preserve context across compaction |
| Permission Auto-Approve | `permission.ask` | `ctx.permission.hook("evaluate")` | Relax `ask` to `allow` for safe operations |

### Custom Tools

| Tool | Description |
|------|-------------|
| run-tests | Run test suite with options |
| check-coverage | Analyze test coverage |
| security-audit | Security vulnerability scan |
| format-code | Detect formatter and return command |
| lint-check | Detect linter and return command |
| git-summary | Generate git summary with branch, status, and diff |
| changed-files | List files changed in session as a navigable tree |
| dependency-analyzer | Analyze dependencies for outdated, vulnerable, and unused packages |

## Hook Event Mapping

OpenCode's plugin system maps to Claude Code hooks:

| Claude Code | OpenCode 1 event | OpenCode 2 registration |
|-------------|------------------|--------------------------|
| PreToolUse | `tool.execute.before` | `ctx.tool.hook("execute.before")` |
| PostToolUse | `tool.execute.after` | `ctx.tool.hook("execute.after")` |
| Stop | `session.idle` | event `session.idle` |
| SessionStart | `session.created` | event `session.created` |
| SessionEnd | `session.deleted` | event `session.deleted` |

OpenCode 2 reports file changes as `filesystem.changed` (OpenCode 1 called the
same idea `file.watcher.updated`) and has no `todo.updated` event, so the todo
progress hook is OpenCode 1 only.

### Hook Runtime Controls

OpenCode plugin hooks honor the same runtime controls used by Claude Code/Cursor:

```bash
export ECC_HOOK_PROFILE=standard
export ECC_DISABLED_HOOKS="pre:bash:tmux-reminder,post:edit:typecheck"
```

- `ECC_HOOK_PROFILE`: `minimal`, `standard` (default), `strict`
- `ECC_DISABLED_HOOKS`: comma-separated hook IDs to disable

## Skills

The default OpenCode config loads 11 curated ECC skills via the `instructions` array:

- coding-standards
- backend-patterns
- frontend-patterns
- frontend-slides
- security-review
- tdd-workflow
- strategic-compact
- eval-harness
- verification-loop
- api-design
- e2e-testing

Additional specialized skills are shipped in `skills/` but not loaded by default to keep OpenCode sessions lean:

- article-writing
- content-engine
- market-research
- investor-materials
- investor-outreach

## Configuration

Full configuration in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugins"],
  "instructions": [
    "skills/tdd-workflow/SKILL.md",
    "skills/security-review/SKILL.md"
  ],
  "agent": { /* 12 agents */ },
  "command": { /* 24 commands */ }
}
```

The reference config intentionally leaves model selection to OpenCode. Connect a
provider and select a model in OpenCode; ECC's primary agent uses that global
selection, and its subagents inherit the invoking primary agent's model.

## License

MIT

Home-target installations keep `plugins/index.ts` inert even with hooks enabled.
OpenCode automatically loads `plugins/ecc-hooks.ts`; loading the barrel as well
would initialize every ECC hook twice. The source and published package barrel
remain available for module imports.

Declining the hook capability during install replaces each disabled plugin file
with an inert placeholder. The placeholder satisfies both contracts (an inert
`server` and `setup`) and derives its id from the entrypoint's path inside
`plugins/`, because OpenCode 2 rejects duplicate ids across the files it
auto-discovers and two entrypoints can share a basename (`plugins/index.ts` and
`plugins/custom/index.ts`).
