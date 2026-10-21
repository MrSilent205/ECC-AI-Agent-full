/**
 * Tests for the OpenCode v1 hook plugin surface.
 *
 * The plugin default-exports a module that carries both host surfaces:
 * `{ id, server, setup }`. A v1 host calls `server(input)` and receives the
 * hook object; a v2 host calls `setup(ctx)`. These tests drive the v1 surface
 * with v1-shaped events and assert the behaviour is identical to the v2
 * surface covered by opencode-plugin-hooks.test.js.
 *
 * The source module is loaded directly (the artifact OpenCode actually loads
 * is the .ts source), not the compiled dist.
 *
 * Run with: node tests/opencode-plugin-v1-hooks.test.js
 */

const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  - ${name}`)
      return { passed: 1, failed: 0 }
    })
    .catch((error) => {
      console.log(`  x ${name}`)
      console.error(`    ${error.stack || error.message}`)
      return { passed: 0, failed: 1 }
    })
}

async function loadPlugin() {
  const pluginUrl = pathToFileURL(
    path.join(__dirname, "..", ".opencode", "plugins", "index.ts")
  ).href
  return import(pluginUrl)
}

async function captureConsole(fn) {
  const out = []
  const methods = ["log", "warn", "error", "debug"]
  const original = {}
  for (const method of methods) {
    original[method] = console[method]
    console[method] = (...args) => {
      out.push({ level: method, message: args.map(String).join(" ") })
    }
  }
  try {
    const result = await fn()
    return { out, result }
  } finally {
    for (const method of methods) {
      console[method] = original[method]
    }
  }
}

function withProfile(value, fn) {
  const previous = process.env.ECC_HOOK_PROFILE
  process.env.ECC_HOOK_PROFILE = value
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.ECC_HOOK_PROFILE
      else process.env.ECC_HOOK_PROFILE = previous
    })
}

async function withTempProject(files, fn) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-v1-"))
  try {
    for (const file of files) {
      const filePath = path.join(projectDir, file)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "")
    }
    return await fn(projectDir)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

/**
 * Minimal v1 plugin input. `client` is intentionally absent: the plugin must
 * fall back to the plugin directory instead of crashing.
 */
function createInput(projectDir) {
  return {
    directory: projectDir,
    worktree: projectDir,
    project: { id: "test-project", worktree: projectDir },
    serverUrl: new URL("http://127.0.0.1:4096"),
  }
}

async function createHooks(projectDir) {
  const { result, out } = await captureConsole(async () => {
    const plugin = await loadPlugin()
    return await plugin.default.server(createInput(projectDir))
  })
  return { hooks: result, logs: out }
}

async function hasZod() {
  try {
    const specifier = "zod"
    const mod = await import(specifier)
    return Boolean(mod.z)
  } catch {
    return false
  }
}

async function main() {
  console.log("\n=== Testing OpenCode v1 plugin hooks ===\n")

  const tests = [
    [
      "default export carries id plus both the v1 server and v2 setup",
      async () => {
        const plugin = await loadPlugin()
        assert.ok(plugin.default && typeof plugin.default === "object")
        assert.strictEqual(plugin.default.id, "ecc-hooks")
        assert.strictEqual(typeof plugin.default.server, "function")
        assert.strictEqual(typeof plugin.default.setup, "function")
      },
    ],
    [
      "module satisfies the v1 loader contract (record with id and server, no tui)",
      async () => {
        const plugin = await loadPlugin()
        const value = plugin.default
        // Mirrors the host loader: the default export must be a record, and it
        // must expose exactly one of server/tui.
        assert.strictEqual(typeof value, "object")
        assert.ok(value !== null)
        assert.ok("id" in value)
        assert.ok("server" in value)
        assert.ok(!("tui" in value))
        assert.strictEqual(typeof value.server, "function")
      },
    ],
    [
      "server returns the v1 hook surface",
      async () => withTempProject([], async (projectDir) => {
        const { hooks } = await createHooks(projectDir)
        assert.strictEqual(typeof hooks.event, "function")
        assert.strictEqual(typeof hooks["tool.execute.before"], "function")
        assert.strictEqual(typeof hooks["tool.execute.after"], "function")
        assert.strictEqual(typeof hooks["shell.env"], "function")
        assert.strictEqual(typeof hooks["permission.ask"], "function")
        assert.strictEqual(typeof hooks["experimental.session.compacting"], "function")
        assert.strictEqual(typeof hooks.dispose, "function")
        assert.ok(hooks.tool && typeof hooks.tool === "object")
      }),
    ],
    [
      "shell.env injects the ECC environment",
      async () => withTempProject(
        ["pnpm-lock.yaml", "tsconfig.json", "pyproject.toml"],
        async (projectDir) => {
          const { hooks } = await createHooks(projectDir)
          const output = { env: {} }
          await hooks["shell.env"]({ cwd: projectDir }, output)

          const env = output.env
          assert.strictEqual(env.PROJECT_ROOT, projectDir)
          assert.strictEqual(env.ECC_PLUGIN, "true")
          assert.ok(env.ECC_VERSION.match(/^\d+\.\d+\.\d+$/), "ECC_VERSION should be a valid semver")
          assert.strictEqual(env.PACKAGE_MANAGER, "pnpm")
          assert.strictEqual(env.DETECTED_LANGUAGES, "typescript,python")
          assert.strictEqual(env.PRIMARY_LANGUAGE, "typescript")
        }
      ),
    ],
    [
      "permission.ask auto-approves read-only actions only",
      async () => withTempProject([], async (projectDir) => {
        const { hooks } = await createHooks(projectDir)

        for (const type of ["read", "glob", "grep"]) {
          const output = { status: "ask" }
          // eslint-disable-next-line no-await-in-loop
          await hooks["permission.ask"]({ type, pattern: "src/index.ts" }, output)
          assert.strictEqual(output.status, "allow", `Expected allow for ${type}`)
        }

        const risky = { status: "ask" }
        await hooks["permission.ask"]({ type: "bash", pattern: "rm -rf /" }, risky)
        assert.strictEqual(risky.status, "ask", "Expected unknown bash commands to stay ask")
      }),
    ],
    [
      "permission.ask auto-approves formatter and test commands",
      async () => withTempProject([], async (projectDir) => {
        const { hooks } = await createHooks(projectDir)

        const formatter = { status: "ask" }
        await hooks["permission.ask"](
          { type: "bash", pattern: "npx prettier --write src/index.ts" },
          formatter
        )
        assert.strictEqual(formatter.status, "allow")

        const test = { status: "ask" }
        await hooks["permission.ask"]({ type: "bash", pattern: "npm test" }, test)
        assert.strictEqual(test.status, "allow")
      }),
    ],
    [
      "tool.execute.before and tool.execute.after track changed files",
      async () => withTempProject([], async (projectDir) => {
        const { hooks } = await createHooks(projectDir)

        const before = { args: { path: "src/other.ts" } }
        await hooks["tool.execute.before"](
          { tool: "edit", sessionID: "session-1", callID: "call-1" },
          before
        )
        await hooks["tool.execute.after"](
          { tool: "edit", sessionID: "session-1", callID: "call-1", args: before.args },
          { title: "edit", output: "done", metadata: {} }
        )

        const storeUrl = pathToFileURL(
          path.join(__dirname, "..", ".opencode", "plugins", "lib", "changed-files-store.ts")
        ).href
        const store = await import(storeUrl)
        assert.ok(
          store
            .getChangedPaths()
            .some((entry) => entry.path === path.normalize("src/other.ts")),
          "Expected the edit tool to record a changed file"
        )
      }),
    ],
    [
      "experimental.session.compacting appends the ECC context block",
      async () => withTempProject([], async (projectDir) => {
        const { hooks } = await createHooks(projectDir)
        const output = { context: [] }
        await hooks["experimental.session.compacting"]({ sessionID: "session-1" }, output)
        assert.strictEqual(output.context.length, 1)
        assert.match(output.context[0], /## Active Plugin: ECC v\d+\.\d+\.\d+/)
      }),
    ],
    [
      "event hook handles session and filesystem events",
      async () => withTempProject(["CLAUDE.md"], async (projectDir) => {
        const { hooks } = await createHooks(projectDir)

        const { out: logs } = await captureConsole(async () => {
          await hooks.event({
            event: { type: "session.created", properties: { info: { directory: projectDir } } },
          })
        })
        assert.ok(
          logs.some((entry) => entry.message === "[ECC] Found CLAUDE.md - loading project context"),
          "Expected CLAUDE.md detection log"
        )

        await hooks.event({
          event: {
            type: "file.watcher.updated",
            properties: { file: "src/example.ts", event: "change" },
          },
        })
        const storeUrl = pathToFileURL(
          path.join(__dirname, "..", ".opencode", "plugins", "lib", "changed-files-store.ts")
        ).href
        const store = await import(storeUrl)
        assert.ok(
          store.getChangedPaths().some((entry) => entry.path === path.normalize("src/example.ts")),
          "Expected file.watcher.updated to record a changed file"
        )

        await hooks.event({ event: { type: "session.deleted", properties: {} } })
        assert.ok(!store.hasChanges(), "Expected session.deleted to clear tracked changes")
      }),
    ],
    [
      "tool map registers the ECC tools when zod is resolvable",
      async () => withTempProject([], async (projectDir) => {
        const { hooks, logs } = await createHooks(projectDir)
        const zodAvailable = await hasZod()
        const names = Object.keys(hooks.tool).sort()

        if (zodAvailable) {
          assert.deepStrictEqual(names, ["changed-files", "dependency-analyzer"])
          const changedFiles = hooks.tool["changed-files"]
          assert.ok(changedFiles.description)
          assert.ok(changedFiles.args.filter)
          const result = await changedFiles.execute({}, { directory: projectDir })
          assert.ok(String(result).includes('"changed":false'))
        } else {
          assert.deepStrictEqual(names, [])
          assert.ok(
            logs.some(
              (entry) =>
                entry.level === "warn" && entry.message.includes("zod is not available")
            ),
            "Expected a warning when zod cannot be resolved"
          )
        }
      }),
    ],
  ]

  let passed = 0
  let failed = 0
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn)
    passed += result.passed
    failed += result.failed
  }

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
