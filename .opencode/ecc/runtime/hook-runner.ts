/**
 * Run one ECC hook script the way Claude Code does: a child Node process with
 * the hook payload as JSON on stdin.
 *
 * Ported from the Pi adapter (`.pi/extensions/index.ts` runEccHook) with the
 * same isolation guarantees:
 *   - `execFile` with no shell, so paths with spaces or metacharacters are safe.
 *   - Never rejects. A missing script, bad runtime override, non-zero exit,
 *     timeout, or spawn error resolves to a result the caller treats as
 *     "no opinion" (fail open), except exit code 2, which is a hook decision.
 *   - stdin EPIPE (a hook exiting before reading its payload) is swallowed so it
 *     cannot surface as an unhandled error inside the OpenCode server.
 */

import { execFile, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024

export interface HookRunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the hook could not run to completion (spawn error, timeout, signal). */
  readonly failure?: string
}

export interface HookInvocation {
  /** Script path relative to the ECC root, e.g. `scripts/hooks/run-with-flags.js`. */
  readonly script: string
  readonly args: readonly string[]
  readonly payload: unknown
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs?: number
}

/**
 * Select a real Node executable for hook scripts.
 *
 * OpenCode v2 ships as a compiled Bun binary, so `process.execPath` is the
 * opencode launcher, not Node. Bun is detected via `process.versions.bun`; both
 * fall back to `node` on PATH unless `ECC_HOOK_NODE` gives an absolute path.
 */
export function resolveHookRuntime({
  execPath = process.execPath,
  releaseName = process.release?.name,
  bunVersion = process.versions?.bun,
  override = process.env.ECC_HOOK_NODE,
}: {
  execPath?: string
  releaseName?: string
  bunVersion?: string
  override?: string
} = {}): string {
  const overridePath = override?.trim()
  if (overridePath) {
    if (!path.isAbsolute(overridePath)) {
      throw new Error("ECC_HOOK_NODE must be an absolute path: " + overridePath)
    }
    return overridePath
  }
  const isNodeRuntime =
    releaseName === "node" && !bunVersion && /^(?:node|nodejs)(?:\.exe)?$/i.test(path.basename(execPath))
  return isNodeRuntime ? execPath : "node"
}

export function runHookScript(root: string, invocation: HookInvocation): Promise<HookRunResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: HookRunResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const scriptPath = path.resolve(root, invocation.script)
    if (!scriptPath.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(scriptPath)) {
      finish({ exitCode: null, stdout: "", stderr: "", failure: `hook script not found: ${invocation.script}` })
      return
    }

    let runtime: string
    try {
      runtime = resolveHookRuntime()
    } catch (error) {
      finish({ exitCode: null, stdout: "", stderr: "", failure: (error as Error).message })
      return
    }

    let child: ReturnType<typeof execFile>
    try {
      child = execFile(
        runtime,
        [scriptPath, ...invocation.args],
        {
          cwd: invocation.cwd,
          env: invocation.env,
          timeout: invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_HOOK_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const out = typeof stdout === "string" ? stdout : ""
          const err = typeof stderr === "string" ? stderr : ""
          if (error) {
            const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? ((error as unknown as { code: number }).code)
              : null
            const killed = (error as { killed?: boolean }).killed
            if (code !== null && !killed) {
              // A plain non-zero exit is a hook result, not a runner failure.
              finish({ exitCode: code, stdout: out, stderr: err })
              return
            }
            finish({ exitCode: null, stdout: out, stderr: err, failure: error.message })
            return
          }
          finish({ exitCode: 0, stdout: out, stderr: err })
        },
      )
    } catch (error) {
      finish({ exitCode: null, stdout: "", stderr: "", failure: (error as Error).message })
      return
    }

    child.on("error", (error) => {
      finish({ exitCode: null, stdout: "", stderr: "", failure: error.message })
    })
    child.stdin?.on("error", () => {
      // EPIPE: the hook exited before reading stdin. Its exit status still
      // arrives through the execFile callback, so there is nothing to report.
    })
    try {
      child.stdin?.end(JSON.stringify(invocation.payload))
    } catch {
      // Same as above: the callback reports the outcome.
    }
  })
}

/**
 * Start a fire-and-forget hook in its own process group so it survives the
 * OpenCode server exiting. `opencode run` shuts its server down a few
 * milliseconds after the session finishes, which would otherwise kill Stop and
 * SessionEnd hooks (session summaries, cost tracking, notifications) mid-run.
 * Output is discarded; lifecycle hooks bound their own runtime through
 * ECC_HOOK_DEADLINE_MS. Resolves once the payload is handed over.
 */
export function detachHookScript(root: string, invocation: HookInvocation): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const scriptPath = path.resolve(root, invocation.script)
    if (!scriptPath.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(scriptPath)) {
      resolve({ exitCode: null, stdout: "", stderr: "", failure: `hook script not found: ${invocation.script}` })
      return
    }
    try {
      const child = spawn(resolveHookRuntime(), [scriptPath, ...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      })
      child.on("error", (error) => resolve({ exitCode: null, stdout: "", stderr: "", failure: error.message }))
      child.stdin?.on("error", () => {})
      child.stdin?.end(JSON.stringify(invocation.payload), () => {
        resolve({ exitCode: null, stdout: "", stderr: "" })
      })
      child.unref()
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", failure: (error as Error).message })
    }
  })
}
