#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const rootDir = path.resolve(__dirname, "..")
const opencodeDir = path.join(rootDir, ".opencode")
const distDir = path.join(opencodeDir, "dist")

fs.rmSync(distDir, { recursive: true, force: true })

let tscEntrypoint

try {
  tscEntrypoint = require.resolve("typescript/bin/tsc", { paths: [rootDir] })
} catch {
  throw new Error(
    "TypeScript compiler not found. Install root dev dependencies before publishing so .opencode/dist can be built."
  )
}

execFileSync(process.execPath, [tscEntrypoint, "-p", path.join(opencodeDir, "tsconfig.json")], {
  cwd: rootDir,
  stdio: "inherit",
})

// tsc's rewriteRelativeImportExtensions covers static imports/exports but can miss
// some dynamic import() specifiers in the compiled output. Normalise them so
// the published .js bundle matches the installed .ts source.
function rewriteDynamicImportsForDist(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) rewriteDynamicImportsForDist(entryPath)
    else if (entry.name.endsWith(".js")) {
      const source = fs.readFileSync(entryPath, "utf8")
      const rewritten = source.replace(/import\((\s*["'])((?:\.\.?\/)[^"']+)\.ts(["']\s*)\)/g, (match, prefix, spec, suffix) =>
        `import(${prefix}${spec}.js${suffix})`
      )
      if (rewritten !== source) fs.writeFileSync(entryPath, rewritten)
    }
  }
}
rewriteDynamicImportsForDist(distDir)
