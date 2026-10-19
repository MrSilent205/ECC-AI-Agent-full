# OpenCode ECC Plugin

> WARNING: This README is specific to OpenCode usage.
> If you installed ECC via npm (e.g. `npm install opencode-ecc`), refer to the root README instead.

ECC plugin for OpenCode: agents, commands, skills, a hook bridge that runs
ECC's shared Claude Code hook scripts, and custom tools.

Supported hosts: **OpenCode v2** (verified on 2.0.24) and OpenCode v1 >= 1.18.29.
The plugin ships one default export that carries both the v2 definition
(`{ id, setup }`) and the v1 entry (`server`); each host ignores the other.

## Installation

### Option 1: Home install (recommended)

Installs ECC into your OpenCode config directory (`$OPENCODE_CONFIG_DIR`,
`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`):

```bash
npx ecc-universal install --target opencode --profile full --enable-hooks
# or from a clone:
node scripts/build-opencode.js
node scripts/install-apply.js --target opencode --profile full --enable-hooks
opencode service restart   # the background service caches plugins and config
```

What lands in the config directory:

- `plugins/ecc.ts`: the only plugin file (OpenCode loads every file in
  `plugins/` as a separate plugin, so helpers live in `ecc/`)
- `ecc/`: hook bridge, runtime and tools
- `commands/`, `prompts/`, `instructions/`, `skills/`
- `scripts/hooks`, `scripts/lib`, `hooks/` and the npm packages those scripts
  need (`scripts/node_modules`) when the hook runtime is enabled
- ECC's `agent` and `command` entries, **merged** into your existing
  `opencode.json`. Your other settings, other plugins' `plugins` entries and
  `permissions` rules (for example OpenCode Ensemble's) are kept, and
  uninstall removes only what ECC added.

Without `--enable-hooks` (or with `--no-hooks`), the plugin entrypoint is
installed inert.

### Option 2: npm package as a plugin

```json
{
  "plugins": ["ecc-universal"]
}
```

This loads the compiled plugin (hook bridge and tools) from the package. It
does not register ECC's agents and commands; use the home install for those.

### Option 3: Direct use

```bash
git clone https://github.com/affaan-m/ECC
cd ECC
opencode
```

OpenCode discovers `.opencode/` in the repository. The repository copy uses a
project-scoped plugin id, so it can run next to a home install without the
duplicate-id failure that would otherwise stop every plugin.

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

### Hook bridge

The plugin runs the same hook scripts Claude Code uses (`hooks/hooks.json`),
through `scripts/hooks/run-with-flags.js` and the dispatchers, so hook IDs,
profiles and `ECC_DISABLED_HOOKS` behave identically. The bridge's table is
generated from `hooks/hooks.json` by `scripts/build-opencode-hook-table.js`.

| Claude Code event | OpenCode v2 trigger | Notes |
|-------------------|---------------------|-------|
| PreToolUse | `tool.hook("execute.before")` | Blocks are shown to the model: shell commands are rewritten to print the ECC reason and exit 2; edits, writes, reads and other permission-checked tools are denied through `permission.hook("evaluate")` with the reason |
| PostToolUse / PostToolUseFailure | `tool.hook("execute.after")` | Hook context is appended to the tool result |
| UserPromptSubmit | `session.hook("prompt")` | Context is injected on the next request; a block is advisory (OpenCode cannot cancel a prompt from a plugin) |
| SessionStart | first `prompt`/`context` hook of a session | `additionalContext` is added to the system prompt on every request |
| PreCompact | `session.hook("compaction")` | Also adds ECC's compaction guidance |
| Stop | `session.execution.succeeded` event | Runs detached, so `opencode run` exiting cannot kill it; advisory |
| SessionEnd | `session.deleted` event | Detached |

Tool names are translated to Claude's (`shell` to Bash, `edit` to Edit,
`write` to Write, `patch` to MultiEdit/Write per file, `read`, `glob`, `grep`,
`skill` to Skill, `subagent` to Task, MCP `<server>_<tool>` to
`mcp__<server>__<tool>`). The Code Mode wrapper (`execute`) is skipped
because every inner call fires its own hook. Child sessions (subagents) skip
SessionStart, Stop and SessionEnd unless `ECC_OPENCODE_CHILD_SESSION_HOOKS=1`.

The plugin also:

- injects `instructions/INSTRUCTIONS.md` into the system prompt (OpenCode v2
  ignores the config `instructions` key); `ECC_OPENCODE_INSTRUCTIONS=0` turns it off
- sets `ECC_*`, `PROJECT_ROOT`, `PACKAGE_MANAGER`, `DETECTED_LANGUAGES` and
  `CLAUDE_PLUGIN_ROOT` in agent shells
- auto-approves reads and formatter/test commands that would otherwise ask
  (`ECC_OPENCODE_AUTO_APPROVE=0` to disable); it never overrides a configured deny

Known limits: OpenCode v2 has no todo tool (no `todo.updated` equivalent),
hooks receive an empty `transcript_path`, prompt and Stop blocks are advisory,
and each tool call starts a few short Node processes. Hooks need `node` on
`PATH` (or an absolute `ECC_HOOK_NODE`). `ECC_OPENCODE_BRIDGE_TRACE=<file>`
writes one JSON line per hook dispatch for debugging.

### Custom tools

Registered as plugin tools (under OpenCode v2 they are called through Code Mode):

| Tool | Description |
|------|-------------|
| ecc_run_tests | Run test suite with options |
| ecc_check_coverage | Analyze test coverage |
| ecc_security_audit | Security vulnerability scan |
| ecc_format_code | Detect formatter and return command |
| ecc_lint_check | Detect linter and return command |
| ecc_git_summary | Generate git summary with branch, status, and diff |
| ecc_changed_files | List files changed in session as a navigable tree |
| ecc_dependency_analyzer | Analyze dependencies for outdated, vulnerable, and unused packages |

On OpenCode v1 the tools keep their hyphenated names (`run-tests`, ...) and
need `@opencode-ai/plugin` to be resolvable.

### Hook runtime controls

```bash
export ECC_HOOK_PROFILE=standard
export ECC_DISABLED_HOOKS="pre:bash:dispatcher,stop:desktop-notify"
```

- `ECC_HOOK_PROFILE`: `minimal`, `standard` (default), `strict`
- `ECC_DISABLED_HOOKS`: comma-separated hook IDs to disable

## Skills

OpenCode scans `<config>/skills` itself, so every installed ECC skill is
available through OpenCode's skill tool; none are preloaded into the prompt.

## Configuration

The repository's `.opencode/opencode.json` holds ECC's `agent` and `command`
entries (v1 keys, which OpenCode v2 converts on load). The reference config
leaves model selection to OpenCode: connect a provider and select a model;
ECC's primary agent uses that selection and its subagents inherit it.

## Using ECC with OpenCode Ensemble

[OpenCode Ensemble](https://github.com/hueyexe/opencode-ensemble) runs agent
teams in parallel sessions. ECC works alongside it:

- ECC never blocks Ensemble's `team_*` tools (`ECC_OPENCODE_PASSTHROUGH_TOOLS`,
  default `team_*`, lists tools that skip PreToolUse blocking).
- Teammate sessions get a note telling them to report through `team_message`,
  so ECC agents whose prompts say "report in your final response" still reach
  the lead.
- ECC agents can be teammates by name: `team_spawn({ agent: "code-reviewer", worktree: false, ... })`.
  Use `worktree: false` for read-only ECC agents (planner, architect, the reviewers).
- The home install keeps Ensemble's `plugins` entry and its
  `external_directory` worktree permission in `opencode.json`.

Ensemble 0.19.0 does not work on OpenCode 2.0.19+ (issue #40); use a release
that includes the 2.0.19+ compatibility fix.

## License

MIT
