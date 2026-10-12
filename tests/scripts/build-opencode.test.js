/**
 * Tests for scripts/build-opencode.js
 */

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")
const { pathToFileURL } = require("url")
const { getNpmPackEntry } = require("../lib/npm-pack-output")
const { createManifestInstallPlan, applyInstallPlan } = require("../../scripts/lib/install-executor")
const { withHookConsent } = require("../../scripts/lib/install/hook-consent")

function checkRuntime(runtimeRoot, extension, loader, installedHome = false) {
  const check = `
    const assert = require("node:assert/strict")
    const fs = require("node:fs")
    const path = require("node:path")
    const { pathToFileURL } = require("node:url")
    const [root, extension, installedHome] = process.argv.slice(1)
    const load = (name) => import(pathToFileURL(path.join(root, name + extension)).href)

    async function main() {
      const { ECC_TOOLS } = await load("ecc/tools/index")
      assert.deepEqual(ECC_TOOLS.map((tool) => tool.name).sort(), [
        "changed_files", "check_coverage", "dependency_analyzer", "format_code",
        "git_summary", "lint_check", "run_tests", "security_audit",
      ])

      const plugin = (await load("plugins/ecc")).default
      assert.deepEqual(Object.keys(plugin).sort(), ["id", "server", "setup"])
      if (installedHome !== "true") {
        const entry = await load("index")
        assert.deepEqual(Object.keys(entry), ["default"])
        assert.equal(entry.default, plugin)
      }

      // Drive the v2 entry with a minimal host: tools register, and a write
      // reported through execute.after reaches the shared changed-files store.
      const hooks = {}
      const tools = []
      const ctx = {
        location: { directory: process.cwd() },
        tool: { transform: async (cb) => cb({ add: (t) => tools.push(t) }), hook: async (n, cb) => { hooks[n] = cb } },
        permission: { hook: async () => {} },
        shell: { hook: async () => {} },
        session: { hook: async () => {} },
        event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
      }
      const dispose = await plugin.setup(ctx)
      assert.ok(tools.some((t) => t.name === "ecc_changed_files"))
      if (hooks["execute.after"]) {
        await hooks["execute.after"]({ tool: "write", sessionID: "s", id: "c", input: { path: "example.txt", content: "x" },
          status: "completed", result: { content: [] } })
        const changedTool = tools.find((t) => t.name === "ecc_changed_files")
        const changed = JSON.parse((await changedTool.execute({ format: "json" }, { sessionID: "s" })).content)
        assert.equal(changed.changed, true)
        assert.deepEqual(changed.files, [{ path: "example.txt", changeType: "modified" }])
      }
      if (typeof dispose === "function") await dispose()
    }
    main().catch((error) => { console.error(error); process.exit(1) })
  `
  const args = loader ? ["--loader", pathToFileURL(loader).href] : []
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ecc-opencode-runtime-"))
  try {
    const home = path.join(fixture, "home")
    const project = path.join(fixture, "project")
    fs.mkdirSync(home)
    fs.mkdirSync(project)
    const result = spawnSync(process.execPath, [...args, "-e", check, runtimeRoot, extension, String(installedHome)], {
      cwd: project,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, HOME: home, USERPROFILE: home,
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ECC_AGENT_DATA_HOME: path.join(home, ".claude"),
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
        ECC_OPENCODE_INSTRUCTIONS: "0",
        OPENCODE_CONFIG_DIR: installedHome ? runtimeRoot : path.join(home, ".config", "opencode") },
    })
    assert.strictEqual(result.status, 0, result.error?.message || result.stderr || result.stdout)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

function runTest(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    return true
  } catch (error) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${error.message}`)
    return false
  }
}

function main() {
  console.log("\n=== Testing build-opencode.js ===\n")

  let passed = 0
  let failed = 0

  const repoRoot = path.join(__dirname, "..", "..")
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  )
  const buildScript = path.join(repoRoot, "scripts", "build-opencode.js")
  const distEntry = path.join(repoRoot, ".opencode", "dist", "index.js")
  const tests = [
    ["package.json exposes the OpenCode build and prepack hooks", () => {
      assert.strictEqual(packageJson.scripts["build:opencode"], "node scripts/build-opencode.js")
      assert.strictEqual(packageJson.scripts.prepack, "npm run build:opencode")
      assert.ok(packageJson.files.includes(".opencode/"))
    }],
    ["build script generates .opencode/dist", () => {
      const result = spawnSync("node", [buildScript], {
        cwd: repoRoot,
        encoding: "utf8",
      })
      assert.strictEqual(result.status, 0, result.stderr)
      assert.ok(fs.existsSync(distEntry), ".opencode/dist/index.js should exist after build")
    }],
    ["package.json declares a resolvable OpenCode plugin entry", () => {
      assert.strictEqual(packageJson.main, ".opencode/dist/index.js")
      assert.ok(packageJson.exports, "package.json must declare an exports map")
      assert.deepStrictEqual(packageJson.exports["."], {
        types: "./.opencode/dist/index.d.ts",
        import: "./.opencode/dist/index.js",
        default: "./.opencode/dist/index.js",
      })
    }],
    ["installed package resolves and imports its root module by name", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-entry-"))
      try {
        fs.mkdirSync(path.join(tempDir, "node_modules"), { recursive: true })
        fs.symlinkSync(
          repoRoot,
          path.join(tempDir, "node_modules", "ecc-universal"),
          process.platform === "win32" ? "junction" : "dir"
        )
        const probe = `
          const resolved = import.meta.resolve("ecc-universal")
          if (!resolved.endsWith("/.opencode/dist/index.js")) {
            throw new Error("unexpected entry resolution: " + resolved)
          }
          const mod = await import("ecc-universal")
          if (Object.keys(mod).join(",") !== "default" || typeof mod.default?.setup !== "function"
            || typeof mod.default?.server !== "function" || typeof mod.default?.id !== "string") {
            throw new Error("root module must export exactly the plugin definition")
          }
        `
        const probePath = path.join(tempDir, "probe.mjs")
        fs.writeFileSync(probePath, probe)
        const result = spawnSync(process.execPath, [probePath], {
          cwd: tempDir,
          encoding: "utf8",
        })
        assert.strictEqual(result.status, 0, result.stderr)
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    }],
    ["OpenCode TypeScript sources resolve their relative imports in place", () => {
      const opencodeDir = path.join(repoRoot, ".opencode")
      const sourceFiles = []
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const entryPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name !== "node_modules" && entry.name !== "dist") walk(entryPath)
          } else if (entry.name.endsWith(".ts")) {
            sourceFiles.push(entryPath)
          }
        }
      }
      walk(opencodeDir)
      assert.ok(sourceFiles.length > 0, "expected OpenCode TypeScript sources")
      const unresolved = []
      for (const sourceFile of sourceFiles) {
        const source = fs.readFileSync(sourceFile, "utf8")
        for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
          const target = path.resolve(path.dirname(sourceFile), match[1])
          if (!fs.existsSync(target)) {
            unresolved.push(`${path.relative(repoRoot, sourceFile)} -> ${match[1]}`)
          }
        }
      }
      assert.deepStrictEqual(unresolved, [])
    }],
    ["built OpenCode entry exports only the dual v2/v1 plugin definition", () => {
      const check = `
        const assert = require("assert")
        const { pathToFileURL } = require("url")

        async function main() {
          const mod = await import(pathToFileURL(process.argv[1]).href)
          assert.deepStrictEqual(Object.keys(mod).sort(), ["default"])
          const plugin = mod.default
          assert.strictEqual(typeof plugin.id, "string")
          assert.strictEqual(typeof plugin.setup, "function", "OpenCode v2 requires setup")
          assert.strictEqual(typeof plugin.server, "function", "OpenCode v1 requires server")

          const hooks = await plugin.server({
            client: { app: { log: () => Promise.resolve() } },
            directory: process.cwd(),
            worktree: process.cwd(),
          })
          for (const hook of ["tool.execute.before", "tool.execute.after", "event", "shell.env",
            "experimental.session.compacting", "permission.ask"]) {
            assert.strictEqual(typeof hooks[hook], "function", "missing v1 hook: " + hook)
          }
        }

        main().catch((error) => {
          console.error(error)
          process.exit(1)
        })
      `
      const result = spawnSync(process.execPath, ["-e", check, distEntry], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ECC_OPENCODE_INSTRUCTIONS: "0" },
      })
      assert.strictEqual(result.status, 0, result.stderr)
    }],
    ["compiled barrels load and share the lazy changed-files store", () => {
      checkRuntime(path.dirname(distEntry), ".js")
    }],
    ["full home install loads TypeScript barrels and the lazy changed-files store", () => {
      // Keep the fixture beneath the repo so the installed tools can resolve
      // the real SDK dependency without installing packages in the user's home.
      const fixture = fs.mkdtempSync(path.join(repoRoot, "tests", ".opencode-home-"))
      try {
        const homeDir = path.join(fixture, "home")
        const projectRoot = path.join(fixture, "project")
        fs.mkdirSync(homeDir)
        fs.mkdirSync(projectRoot)
        const plan = withHookConsent(createManifestInstallPlan({
          sourceRoot: repoRoot,
          homeDir,
          projectRoot,
          env: {},
          target: "opencode",
          profileId: "full",
        }), "enabled")
        applyInstallPlan(plan)
        const config = JSON.parse(fs.readFileSync(path.join(plan.targetRoot, "opencode.json"), "utf8"))
        // Only ECC's agents and commands are merged; OpenCode scans <root>/skills itself.
        assert.deepStrictEqual(Object.keys(config).sort(), ["agent", "command"])
        assert.ok(fs.existsSync(path.join(plan.targetRoot, "skills", "tdd-workflow", "SKILL.md")))
        assert.deepStrictEqual(fs.readdirSync(path.join(plan.targetRoot, "plugins")), ["ecc.ts"])
        for (const absent of ["package.json", "tsconfig.json", "index.ts", "dist", "tools"]) {
          assert.ok(!fs.existsSync(path.join(plan.targetRoot, absent)), `${absent} must not be installed into the config root`)
        }
        assert.ok(fs.existsSync(path.join(plan.targetRoot, "scripts", "hooks", "run-with-flags.js")))
        assert.ok(fs.existsSync(path.join(plan.targetRoot, "scripts", "node_modules", "js-yaml", "package.json")))
        checkRuntime(
          plan.targetRoot,
          ".ts",
          path.join(repoRoot, "tests", "fixtures", "opencode-ts-loader.mjs"),
          true,
        )
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true })
      }
    }],
    ["npm pack includes the compiled OpenCode dist payload", () => {
      fs.rmSync(path.dirname(distEntry), { recursive: true, force: true })
      const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts=false"], {
        cwd: repoRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
      })
      assert.strictEqual(result.status, 0, result.error?.message || result.stderr)

      const packOutput = JSON.parse(result.stdout)
      const packEntry = getNpmPackEntry(packOutput, packageJson.name)
      const packagedPaths = new Set(packEntry?.files?.map((file) => file.path) ?? [])

      assert.ok(
        packagedPaths.has(".opencode/dist/index.js"),
        "npm pack should include .opencode/dist/index.js"
      )
      assert.ok(
        packagedPaths.has(".opencode/dist/plugins/ecc.js"),
        "npm pack should include compiled OpenCode plugin output"
      )
      assert.ok(
        packagedPaths.has(".opencode/dist/ecc/tools/index.js"),
        "npm pack should include compiled OpenCode tool output"
      )
      assert.ok(
        packagedPaths.has(".opencode/dist/ecc/bridge/hook-table.generated.json"),
        "npm pack should include the compiled bridge hook table"
      )
      for (const runtime of ["scripts/hooks/run-with-flags.js", "hooks/hooks.json", "scripts/lib/utils.js"]) {
        assert.ok(packagedPaths.has(runtime), `npm pack should include ${runtime} for the plugin's hook bridge`)
      }
      assert.ok(
        packagedPaths.has(".claude-plugin/marketplace.json"),
        "npm pack should include .claude-plugin/marketplace.json"
      )
      assert.ok(
        packagedPaths.has(".claude-plugin/plugin.json"),
        "npm pack should include .claude-plugin/plugin.json"
      )
      assert.ok(
        packagedPaths.has(".codex-plugin/plugin.json"),
        "npm pack should include .codex-plugin/plugin.json"
      )
      assert.ok(
        packagedPaths.has(".agents/plugins/marketplace.json"),
        "npm pack should include .agents/plugins/marketplace.json"
      )
      assert.ok(
        packagedPaths.has(".opencode/package.json"),
        "npm pack should include .opencode/package.json"
      )
      assert.ok(
        packagedPaths.has(".opencode/package-lock.json"),
        "npm pack should include .opencode/package-lock.json"
      )
      assert.ok(
        packagedPaths.has("agent.yaml"),
        "npm pack should include agent.yaml"
      )
      assert.ok(
        packagedPaths.has("AGENTS.md"),
        "npm pack should include AGENTS.md"
      )
      assert.ok(
        packagedPaths.has("VERSION"),
        "npm pack should include VERSION"
      )
    }],
  ]

  for (const [name, fn] of tests) {
    if (runTest(name, fn)) {
      passed += 1
    } else {
      failed += 1
    }
  }

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
