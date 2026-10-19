/**
 * Tests for the OpenCode v2 plugin and its shared-script hook bridge.
 *
 * Loads the compiled plugin from .opencode/dist and drives it with a fake v2
 * context (tool/permission/session/shell hooks plus an event stream) and
 * fixture hook scripts that record their input and return chosen decisions.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..');
const dist = path.join(repoRoot, '.opencode', 'dist');

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      return { passed: 1, failed: 0 };
    })
    .catch(error => {
      console.log(`  ✗ ${name}`);
      console.error(`    ${error.stack || error.message}`);
      return { passed: 0, failed: 1 };
    });
}

const load = rel => import(pathToFileURL(path.join(dist, rel)).href);

/** Hook script that logs its argv/payload/env and answers according to its mode. */
const FIXTURE_HOOK = `
const fs = require("fs")
let raw = ""
process.stdin.on("data", (c) => (raw += c))
process.stdin.on("end", () => {
  const mode = process.argv[2]
  const payload = raw ? JSON.parse(raw) : null
  fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({
    mode, payload,
    env: { root: process.env.CLAUDE_PLUGIN_ROOT, project: process.env.CLAUDE_PROJECT_DIR, session: process.env.CLAUDE_SESSION_ID },
  }) + "\\n")
  if (mode === "block") { process.stderr.write("blocked for testing"); process.exit(2) }
  if (mode === "deny-json") { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "json deny" } })); return }
  if (mode === "ask") { process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "please confirm" } })); return }
  if (mode === "context") { process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "CTX-" + payload.hook_event_name } })); return }
  if (mode === "echo") { process.stdout.write(raw); return }
  if (mode === "crash") { throw new Error("boom") }
  if (mode === "slow") { setTimeout(() => {}, 5000); return }
})
`;

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc-root-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'utils.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'run-with-flags.js'), '\n');
  fs.writeFileSync(path.join(root, 'scripts', 'hooks', 'fixture-hook.js'), FIXTURE_HOOK);
  fs.writeFileSync(path.join(root, 'scripts', 'package.json'), '{"type":"commonjs"}\n');
  return root;
}

function row(event, matcher, mode, extra = {}) {
  return { event, matcher, id: `fixture:${event}:${mode}`, kind: 'flags', argv: ['scripts/hooks/fixture-hook.js', mode], async: false, timeoutMs: 3000, ...extra };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

/** Fake OpenCode v2 plugin context. */
function makeContext(directory) {
  const hooks = { tool: {}, permission: {}, session: {}, shell: {} };
  const tools = [];
  const queue = [];
  let wake;
  let closed = false;
  const ctx = {
    location: { directory },
    tool: {
      transform: async cb => cb({ add: t => tools.push(t) }),
      hook: async (name, cb) => {
        hooks.tool[name] = cb;
      }
    },
    permission: {
      hook: async (name, cb) => {
        hooks.permission[name] = cb;
      }
    },
    shell: {
      hook: async (name, cb) => {
        hooks.shell[name] = cb;
      }
    },
    session: {
      hook: async (name, cb) => {
        hooks.session[name] = cb;
      }
    },
    mcp: { list: async () => [{ name: 'github' }] },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!closed && !signal?.aborted) {
            if (queue.length) {
              yield queue.shift();
              continue;
            }
            await new Promise(resolve => {
              wake = resolve;
              signal?.addEventListener('abort', resolve, { once: true });
            });
          }
        }
      })
    }
  };
  return {
    ctx,
    hooks,
    tools,
    emit(event) {
      queue.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    }
  };
}

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await tick(25);
  }
  assert.fail('condition not met in time');
}

async function main() {
  console.log('\n=== Testing OpenCode v2 plugin bridge ===\n');
  const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-opencode.js')], { cwd: repoRoot, encoding: 'utf8' });
  assert.strictEqual(build.status, 0, build.stderr || build.stdout);

  const translate = await load('ecc/bridge/translate.js');
  const { interpretHookResult } = await load('ecc/runtime/hook-result.js');
  const { HookBridge, matchesTool, HOOK_ROWS } = await load('ecc/bridge/hook-bridge.js');
  const { BlockLedger, permissionActionFor } = await load('ecc/bridge/block-ledger.js');
  const { setupV2 } = await load('ecc/bridge/v2.js');
  const { shouldAutoApprove, buildShellEnv } = await load('ecc/bridge/shared.js');
  const { resolveHookRuntime } = await load('ecc/runtime/hook-runner.js');

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc-project-'));
  const tests = [
    [
      'entry: default export is a v2 definition with a v1 server and nothing else',
      async () => {
        const mod = await import(pathToFileURL(path.join(dist, 'plugins', 'ecc.js')).href);
        assert.deepStrictEqual(Object.keys(mod), ['default']);
        assert.strictEqual(typeof mod.default.id, 'string');
        assert.match(mod.default.id, /^ecc(\.project\.[0-9a-f]{8})?$/);
        assert.strictEqual(typeof mod.default.setup, 'function');
        assert.strictEqual(typeof mod.default.server, 'function');
        // The compiled copy (npm package) is not a project .opencode/ copy.
        assert.strictEqual(mod.default.id, 'ecc');
        const source = fs.readFileSync(path.join(repoRoot, '.opencode', 'plugins', 'ecc.ts'), 'utf8');
        assert.match(source, /"ecc\.project\." \+/, 'repo .opencode/ copies use a project-scoped id');
      }
    ],

    [
      'entry: the plugins/ directory holds exactly one plugin file',
      () => {
        const files = fs.readdirSync(path.join(repoRoot, '.opencode', 'plugins'));
        assert.deepStrictEqual(files, ['ecc.ts']);
      }
    ],

    [
      'hook table: committed table matches hooks/hooks.json',
      () => {
        const check = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-opencode-hook-table.js'), '--check'], { encoding: 'utf8' });
        assert.strictEqual(check.status, 0, check.stderr);
        assert.ok(HOOK_ROWS.length > 0);
        for (const r of HOOK_ROWS) {
          assert.match(r.argv[0], /^scripts\/hooks\/[a-z0-9-]+\.js$/);
          assert.ok(fs.existsSync(path.join(repoRoot, r.argv[0])), `${r.id}: ${r.argv[0]} exists`);
        }
      }
    ],

    [
      'translate: v2 built-ins map onto Claude tool names and inputs',
      () => {
        const o = { directory: project, mcpServers: new Set(['github']) };
        assert.deepStrictEqual(translate.translateToolCall('execute', { code: 'x' }, o), []);
        const [bash] = translate.translateToolCall('shell', { command: 'ls', workdir: 'sub', background: true }, o);
        assert.strictEqual(bash.tool_name, 'Bash');
        assert.strictEqual(bash.tool_input.command, 'ls');
        assert.strictEqual(bash.tool_input.cwd, path.join(project, 'sub'));
        assert.strictEqual(bash.tool_input.run_in_background, true);
        const [edit] = translate.translateToolCall('edit', { path: 'a.ts', oldString: 'x', newString: 'y' }, o);
        assert.deepStrictEqual(edit, { tool_name: 'Edit', tool_input: { file_path: path.join(project, 'a.ts'), old_string: 'x', new_string: 'y', replace_all: false } });
        const [write] = translate.translateToolCall('write', { path: '/abs/b.ts', content: 'c' }, o);
        assert.deepStrictEqual(write, { tool_name: 'Write', tool_input: { file_path: '/abs/b.ts', content: 'c' } });
        assert.strictEqual(translate.translateToolCall('read', { path: 'r.md' }, o)[0].tool_input.file_path, path.join(project, 'r.md'));
        assert.deepStrictEqual(translate.translateToolCall('skill', { id: 'tdd-workflow' }, o)[0].tool_input.skill, 'tdd-workflow');
        assert.strictEqual(translate.translateToolCall('subagent', { agent: 'planner', prompt: 'p' }, o)[0].tool_input.subagent_type, 'planner');
        assert.strictEqual(translate.translateToolCall('github_create_issue', {}, o)[0].tool_name, 'mcp__github__create_issue');
        assert.strictEqual(translate.translateToolCall('team_message', { to: 'lead' }, o)[0].tool_name, 'team_message');
      }
    ],

    [
      'translate: patch envelopes become one call per file',
      () => {
        const patch = [
          '*** Begin Patch',
          '*** Add File: new.ts',
          '+export const a = 1',
          '*** Update File: old.ts',
          '@@',
          ' keep',
          '-before',
          '+after',
          '*** Delete File: gone.ts',
          '*** End Patch'
        ].join('\n');
        const calls = translate.translateToolCall('patch', { patchText: patch }, { directory: project });
        assert.deepStrictEqual(
          calls.map(c => c.tool_name),
          ['Write', 'MultiEdit', 'Bash']
        );
        assert.strictEqual(calls[0].tool_input.content, 'export const a = 1');
        assert.deepStrictEqual(calls[1].tool_input.edits, [{ old_string: 'keep\nbefore', new_string: 'keep\nafter' }]);
        assert.deepStrictEqual(translate.writtenFiles(calls), [path.join(project, 'new.ts'), path.join(project, 'old.ts')]);
      }
    ],

    [
      'hook result: exit 2, JSON deny/block/ask, context, echo and failures',
      () => {
        const payload = '{"a":1}';
        assert.deepStrictEqual(interpretHookResult({ exitCode: 2, stdout: '', stderr: ' nope ' }, payload).reason, 'nope');
        assert.strictEqual(
          interpretHookResult({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'r' } }), stderr: '' }, payload).decision,
          'block'
        );
        assert.strictEqual(interpretHookResult({ exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: 'r' }), stderr: '' }, payload).decision, 'block');
        assert.strictEqual(interpretHookResult({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }), stderr: '' }, payload).decision, 'ask');
        assert.strictEqual(interpretHookResult({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'hi' } }), stderr: '' }, payload).additionalContext, 'hi');
        const echoed = interpretHookResult({ exitCode: 0, stdout: payload, stderr: '' }, payload);
        assert.strictEqual(echoed.decision, 'allow');
        assert.strictEqual(echoed.plainOutput, undefined);
        const failed = interpretHookResult({ exitCode: null, stdout: '', stderr: '', failure: 'timeout' }, payload);
        assert.strictEqual(failed.decision, 'allow');
        assert.strictEqual(interpretHookResult({ exitCode: 1, stdout: '', stderr: 'err' }, payload).decision, 'allow');
      }
    ],

    [
      'matcher: Claude Code semantics',
      () => {
        assert.ok(matchesTool('', 'Bash'));
        assert.ok(matchesTool('.*', 'anything'));
        assert.ok(matchesTool('Edit|Write', 'write'));
        assert.ok(!matchesTool('Edit|Write', 'MultiEdit'));
        assert.ok(matchesTool('^mcp__', 'mcp__github__x'));
        assert.ok(!matchesTool('^mcp__', 'Bash'));
      }
    ],

    [
      'ledger: decisions match by session, action and resource, then expire',
      () => {
        let now = 0;
        const ledger = new BlockLedger(() => now);
        ledger.add({ sessionID: 's', callID: 'c1', action: 'edit', resources: ['/p/a.ts', 'a.ts'], effect: 'deny', message: 'm' });
        assert.strictEqual(ledger.take('s', 'edit', ['b.ts']), undefined);
        assert.strictEqual(ledger.take('other', 'edit', ['a.ts']), undefined);
        assert.strictEqual(ledger.take('s', 'edit', ['a.ts']).message, 'm');
        assert.strictEqual(ledger.size, 0);
        ledger.add({ sessionID: 's', callID: 'c2', action: 'edit', resources: [], effect: 'deny', message: 'm' });
        ledger.clearCall('c2');
        assert.strictEqual(ledger.size, 0);
        ledger.add({ sessionID: 's', callID: 'c3', action: 'edit', resources: [], effect: 'deny', message: 'm' });
        now = 60_000;
        assert.strictEqual(ledger.take('s', 'edit', []), undefined);
        assert.strictEqual(permissionActionFor('write'), 'edit');
        assert.strictEqual(permissionActionFor('team_message'), null);
        assert.strictEqual(permissionActionFor('github_x', new Set(['github'])), 'github_x');
      }
    ],

    [
      'auto-approve only relaxes reads and formatter/test commands',
      () => {
        assert.ok(shouldAutoApprove('read', ['x'], {}));
        assert.ok(shouldAutoApprove('shell', ['npm test', 'npx prettier --write a'], {}));
        assert.ok(!shouldAutoApprove('shell', ['npm test', 'rm -rf /'], {}));
        assert.ok(!shouldAutoApprove('edit', ['a'], {}));
        assert.ok(!shouldAutoApprove('read', ['x'], { ECC_OPENCODE_AUTO_APPROVE: '0' }));
      }
    ],

    [
      'shell env exports ECC root without clobbering an existing one',
      () => {
        fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');
        const env = buildShellEnv({ PATH: '/bin' }, { directory: project, root: '/ecc', version: '9.9.9', env: {} });
        assert.strictEqual(env.ECC_VERSION, '9.9.9');
        assert.strictEqual(env.PACKAGE_MANAGER, 'pnpm');
        assert.strictEqual(env.CLAUDE_PLUGIN_ROOT, '/ecc');
        assert.strictEqual(env.PATH, '/bin');
        const kept = buildShellEnv({ CLAUDE_PLUGIN_ROOT: '/mine' }, { directory: project, root: '/ecc', version: '1', env: {} });
        assert.strictEqual(kept.CLAUDE_PLUGIN_ROOT, '/mine');
      }
    ],

    [
      'hook runtime never uses the Bun-compiled host binary',
      () => {
        assert.strictEqual(resolveHookRuntime({ execPath: '/opt/opencode', releaseName: 'node', bunVersion: '1.2.0', override: '' }), 'node');
        assert.strictEqual(resolveHookRuntime({ execPath: '/usr/bin/node', releaseName: 'node', bunVersion: undefined, override: '' }), '/usr/bin/node');
        assert.throws(() => resolveHookRuntime({ override: 'relative/node' }));
      }
    ],

    [
      'bridge: block wins, failures fail open, hook env is set',
      async () => {
        const root = makeFixtureRoot();
        const log = path.join(root, 'log.jsonl');
        const bridge = new HookBridge({
          root,
          directory: project,
          env: { ...process.env, FIXTURE_LOG: log },
          rows: [row('PreToolUse', 'Bash', 'allow'), row('PreToolUse', 'Bash', 'crash'), row('PreToolUse', 'Bash', 'block'), row('PreToolUse', 'Write', 'deny-json')]
        });
        const result = await bridge.dispatch('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { toolName: 'Bash', sessionID: 'ses_1' });
        assert.strictEqual(result.decision, 'block');
        assert.strictEqual(result.reason, 'blocked for testing');
        assert.strictEqual(result.hookId, 'fixture:PreToolUse:block');
        const entries = readLog(log);
        assert.strictEqual(entries.length, 3, 'Write-only row must not run for Bash');
        assert.deepStrictEqual(entries[0].env, { root, project, session: 'ses_1' });
        const crashOnly = new HookBridge({ root, directory: project, env: { ...process.env, FIXTURE_LOG: log }, rows: [row('PreToolUse', '', 'crash')] });
        assert.strictEqual((await crashOnly.dispatch('PreToolUse', {}, { toolName: 'Bash' })).decision, 'allow');
      }
    ],

    [
      'bridge: async rows are detached and do not delay the decision',
      async () => {
        const root = makeFixtureRoot();
        const log = path.join(root, 'log.jsonl');
        const bridge = new HookBridge({ root, directory: project, env: { ...process.env, FIXTURE_LOG: log }, rows: [row('PreToolUse', '', 'slow', { async: true }), row('PreToolUse', '', 'allow')] });
        const started = Date.now();
        const result = await bridge.dispatch('PreToolUse', { hook_event_name: 'PreToolUse' }, { toolName: 'Bash' });
        assert.strictEqual(result.decision, 'allow');
        assert.ok(Date.now() - started < 2500, 'slow async hook must not be awaited');
        await waitFor(() => readLog(log).some(e => e.mode === 'slow'));
      }
    ],

    [
      'setupV2: tools, blocks, context, prompts, Stop and compaction end to end',
      async () => {
        const root = makeFixtureRoot();
        const log = path.join(root, 'log.jsonl');
        const fake = makeContext(project);
        const logs = [];
        const rows = [
          row('PreToolUse', 'Bash', 'block'),
          row('PreToolUse', 'Write', 'block'),
          row('PreToolUse', 'Read', 'ask'),
          row('PreToolUse', 'team_message', 'block'),
          row('PostToolUse', '', 'context'),
          row('SessionStart', '', 'context'),
          row('UserPromptSubmit', '', 'context'),
          row('PreCompact', '', 'allow'),
          row('Stop', '', 'allow'),
          row('SessionEnd', '', 'allow')
        ];
        const dispose = await setupV2(fake.ctx, { root, hooksAvailable: true, version: '1.2.3' }, (level, message) => logs.push({ level, message }), {
          rows,
          env: { ...process.env, FIXTURE_LOG: log, ECC_OPENCODE_INSTRUCTIONS: '0' }
        });
        const { hooks, tools } = fake;

        // Tools: registered under ecc_*, plain JSON Schema, never throw.
        assert.ok(tools.some(t => t.name === 'ecc_run_tests'));
        const changed = tools.find(t => t.name === 'ecc_changed_files');
        assert.strictEqual(changed.input.type, 'object');
        assert.deepStrictEqual(changed.input.properties.format.enum, ['tree', 'json']);
        const out = await changed.execute({ format: 'json' }, { sessionID: 'ses_a', id: 'call_t' });
        assert.strictEqual(typeof out.content, 'string');

        // Shell block: command rewritten so the model sees the ECC reason.
        const shell = { tool: 'shell', sessionID: 'ses_a', id: 'call_1', input: { command: 'rm -rf build' } };
        await hooks.tool['execute.before'](shell);
        assert.match(shell.input.command, /exit 2$/);
        assert.match(shell.input.command, /\[ECC fixture:PreToolUse:block\] blocked for testing/);

        // Write block: deferred to permission.evaluate as a deny with the reason.
        await hooks.tool['execute.before']({ tool: 'write', sessionID: 'ses_a', id: 'call_2', input: { path: 'x.json', content: '{}' } });
        const evaluation = { sessionID: 'ses_a', action: 'edit', resources: ['x.json'], effect: 'allow' };
        await hooks.permission.evaluate(evaluation);
        assert.strictEqual(evaluation.effect, 'deny');
        assert.match(evaluation.message, /blocked for testing/);

        // Ask: becomes an ask, not a deny.
        await hooks.tool['execute.before']({ tool: 'read', sessionID: 'ses_a', id: 'call_3', input: { path: 'r.md' } });
        const askEval = { sessionID: 'ses_a', action: 'read', resources: ['r.md'], effect: 'allow' };
        await hooks.permission.evaluate(askEval);
        assert.strictEqual(askEval.effect, 'ask');

        // Without a pending decision, reads are auto-approved; denies stay denies.
        const plain = { sessionID: 'ses_a', action: 'read', resources: ['z.md'], effect: 'ask' };
        await hooks.permission.evaluate(plain);
        assert.strictEqual(plain.effect, 'allow');
        const denied = { sessionID: 'ses_a', action: 'read', resources: ['z.md'], effect: 'deny' };
        await hooks.permission.evaluate(denied);
        assert.strictEqual(denied.effect, 'deny');

        // execute (code mode) and team_* never reach PreToolUse hooks.
        const before = readLog(log).length;
        await hooks.tool['execute.before']({ tool: 'execute', sessionID: 'ses_a', id: 'call_4', input: { code: 'x' } });
        await hooks.tool['execute.before']({ tool: 'team_message', sessionID: 'ses_a', id: 'call_5', input: { to: 'lead' } });
        assert.strictEqual(readLog(log).length, before);

        // PostToolUse context is appended to the tool result content.
        const after = {
          tool: 'shell',
          sessionID: 'ses_a',
          id: 'call_6',
          input: { command: 'ls' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'out' }], output: { exit: 0, output: 'out' } }
        };
        await hooks.tool['execute.after'](after);
        assert.strictEqual(after.result.content.length, 2);
        assert.match(after.result.content[1].text, /CTX-PostToolUse/);

        // Prompt + context: SessionStart and prompt context are injected each request.
        await hooks.session.prompt({ sessionID: 'ses_a', messageID: 'm1', prompt: { text: 'hello' }, delivery: 'steer' });
        for (let i = 0; i < 2; i++) {
          const request = { sessionID: 'ses_a', agent: 'build', system: [], messages: [], tools: { team_message: {} } };
          await hooks.session.context(request);
          const text = request.system.map(s => s.text).join('\n');
          assert.match(text, /CTX-SessionStart/);
          assert.match(text, /CTX-UserPromptSubmit/);
          assert.match(text, /team_message/);
        }
        assert.strictEqual(readLog(log).filter(e => e.mode === 'context' && e.payload.hook_event_name === 'SessionStart').length, 1, 'SessionStart runs once per session');
        const prompt = readLog(log).find(e => e.payload?.hook_event_name === 'UserPromptSubmit');
        assert.strictEqual(prompt.payload.prompt, 'hello');

        // Compaction pushes ECC guidance.
        const compaction = { sessionID: 'ses_a', system: [], messages: [], tools: {} };
        await hooks.session.compaction(compaction);
        assert.match(compaction.system[0].text, /ECC 1\.2\.3/);

        // Shell env.
        const shellEnv = { command: 'ls', cwd: project, env: {} };
        await hooks.shell['create.before'](shellEnv);
        assert.strictEqual(shellEnv.env.ECC_PLUGIN, 'true');

        // Stop only for sessions this instance knows; children are skipped.
        fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_unknown' } });
        fake.emit({ type: 'session.created', location: { directory: project }, data: { sessionID: 'ses_child', parentID: 'ses_a', location: { directory: project } } });
        fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
        fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } });
        fake.emit({ type: 'session.deleted', data: { sessionID: 'ses_a' } });
        await waitFor(() => readLog(log).some(e => e.payload?.hook_event_name === 'SessionEnd'));
        const stops = readLog(log).filter(e => e.payload?.hook_event_name === 'Stop');
        assert.deepStrictEqual(
          stops.map(e => e.payload.session_id),
          ['ses_a']
        );

        fake.close();
        await dispose();
        assert.ok(!logs.some(l => /hook error ignored/.test(l.message)), JSON.stringify(logs));
      }
    ],

    [
      'setupV2: a broken hook callback never throws into OpenCode',
      async () => {
        const root = makeFixtureRoot();
        const fake = makeContext(project);
        const logs = [];
        const dispose = await setupV2(fake.ctx, { root, hooksAvailable: true, version: '1' }, (level, message) => logs.push(message), {
          rows: [],
          env: { ...process.env, ECC_OPENCODE_INSTRUCTIONS: '0' }
        });
        await fake.hooks.session.context({ sessionID: 's', system: null, tools: { team_message: {} } });
        assert.ok(logs.some(m => /session.context hook error ignored/.test(m)));
        fake.close();
        await dispose();
      }
    ],

    [
      'setupV2: without the hooks runtime only tools are registered',
      async () => {
        const fake = makeContext(project);
        const dispose = await setupV2(fake.ctx, { root: null, hooksAvailable: false, version: '1' }, () => {});
        assert.ok(fake.tools.length >= 8);
        assert.strictEqual(fake.hooks.tool['execute.before'], undefined);
        await dispose();
      }
    ]
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn);
    passed += result.passed;
    failed += result.failed;
  }
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
