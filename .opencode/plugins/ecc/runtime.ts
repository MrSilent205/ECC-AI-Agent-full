/**
 * Shared ECC hook runtime.
 *
 * OpenCode v2-only. This fork is optimized exclusively for OpenCode.
 * For Claude/Codex use the upstream ECC repository.
 *
 * Framework-free on purpose: no `@opencode-ai/plugin` import, so this module
 * loads in any directory without node_modules.
 *
 * This file is the composition root: it wires the hook factories from
 * `tool-hooks`, `session-hooks`, and `permission` into one runtime object.
 */

import * as fs from "fs"
import * as path from "path"
import { pathToFileURL } from "url"

import type {
  ChangedFilesStore,
  EccRuntime,
  EccRuntimeOptions,
  HookGate,
  HookProfile,
  LogFn,
  ToolRunners,
} from "./types.ts"
import { ECC_ROOT_PROBES, findEccRootDir, getShell, normalizeProfile, resolvedRuntimeDir } from "./environment.ts"
import { createPermissionHook } from "./permission.ts"
import {
  createCompactionHook,
  createSessionHooks,
  createShellEnvHook,
} from "./session-hooks.ts"
import { createToolHooks } from "./tool-hooks.ts"

export type {
  EccRuntime,
  EccRuntimeOptions,
  HookProfile,
  LogFn,
  LogLevel,
  PermissionDecision,
  ShellFn,
  ToolRunners,
} from "./types.ts"

async function loadToolRunners(log: LogFn): Promise<ToolRunners | undefined> {
  try {
    const changed = await import("../../tools/changed-files.ts")
    const analyzer = await import("../../tools/dependency-analyzer.ts")
    return {
      changedFilesDescription: changed.changedFilesDescription,
      dependencyAnalyzerDescription: analyzer.dependencyAnalyzerDescription,
      executeChangedFiles: (args, dir) => changed.executeChangedFiles(args, dir),
      executeDependencyAnalyzer: (args, dir) => analyzer.executeDependencyAnalyzer(args, dir),
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    log("warn", `[ECC] Custom tools disabled: could not load tool runners. ${msg}`)
    return undefined
  }
}

function createHookGate(currentProfile: HookProfile): HookGate {
  const disabledHooks = new Set(
    (process.env.ECC_DISABLED_HOOKS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )
  const profileOrder: Record<HookProfile, number> = {
    minimal: 0,
    standard: 1,
    strict: 2,
  }
  return (hookId, required = "standard") => {
    if (disabledHooks.has(hookId)) return false
    const need = Array.isArray(required) ? required : [required]
    return need.some((entry) => profileOrder[currentProfile] >= profileOrder[entry])
  }
}

function createSessionDirResolver(
  projectDir: string,
  sessionDirs: Map<string, string>,
  resolveSessionDir: (sessionID: string) => Promise<string>
): (sessionID: string | undefined) => Promise<string> {
  return async (sessionID) => {
    if (!sessionID) return projectDir
    const cached = sessionDirs.get(sessionID)
    if (cached) return cached
    try {
      const resolved = await resolveSessionDir(sessionID)
      if (resolved) {
        sessionDirs.set(sessionID, resolved)
        return resolved
      }
    } catch {
      // fall through to the plugin location directory
    }
    return projectDir
  }
}

async function loadChangedFilesStore(
  projectDir: string,
  log: LogFn
): Promise<ChangedFilesStore | undefined> {
  try {
    const store = await import("../lib/changed-files-store.ts")
    store.initStore(projectDir)
    return store
  } catch {
    log(
      "warn",
      "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
    )
    return undefined
  }
}

type SkillRunTrackerModule = { run?: (payload: unknown) => void }

async function loadSkillTracker(
  trackerRoot: string | null,
  log: LogFn
): Promise<((payload: unknown) => void) | undefined> {
  try {
    const trackerPath = trackerRoot
      ? path.join(trackerRoot, "scripts", "hooks", "skill-run-tracker.js")
      : null
    if (!trackerPath || !fs.existsSync(trackerPath)) {
      throw new Error("skill-run-tracker.js not found")
    }
    const loaded = (await import(pathToFileURL(trackerPath).href)) as SkillRunTrackerModule & {
      default?: SkillRunTrackerModule
    }
    const entry = typeof loaded.run === "function" ? loaded : loaded.default
    if (!entry || typeof entry.run !== "function") {
      throw new Error("skill-run-tracker.js exposes no run()")
    }
    return entry.run
  } catch {
    log(
      "warn",
      "[ECC] skill-run telemetry disabled: could not load scripts/hooks/skill-run-tracker.js. " +
        "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
    )
    return undefined
  }
}

function disposeRuntime(
  editedFiles: Set<string>,
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>,
  sessionDirs: Map<string, string>
): void {
  editedFiles.clear()
  pendingToolChanges.clear()
  sessionDirs.clear()
}

interface RuntimeState {
  editedFiles: Set<string>
  pendingToolChanges: Map<string, { path: string; type: "added" | "modified" }>
  sessionDirs: Map<string, string>
}

function createRuntimeState(): RuntimeState {
  return {
    editedFiles: new Set<string>(),
    pendingToolChanges: new Map<string, { path: string; type: "added" | "modified" }>(),
    sessionDirs: new Map<string, string>(),
  }
}

interface RuntimeHookContext extends RuntimeState {
  projectDir: string
  log: LogFn
  shell: ReturnType<typeof getShell>
  currentProfile: HookProfile
  hookEnabled: HookGate
  eccRoot: string | null
  changedFilesStore: ChangedFilesStore | undefined
  recordSkillRun: ((payload: unknown) => void) | undefined
  sessionDir: (sessionID: string | undefined) => Promise<string>
}

type RuntimeHooks = Omit<EccRuntime, "projectDir" | "currentProfile" | "dispose">

function createRuntimeHooks(context: RuntimeHookContext): RuntimeHooks {
  const { projectDir, log, shell, currentProfile, hookEnabled, eccRoot } = context
  const { changedFilesStore, recordSkillRun, sessionDir, editedFiles, pendingToolChanges } = context

  const { toolBefore, toolAfter } = createToolHooks({
    projectDir,
    log,
    shell,
    hookEnabled,
    editedFiles,
    pendingToolChanges,
    changedFilesStore,
    recordSkillRun,
    sessionDir,
  })

  const { onSessionCreated, onSessionIdle, onSessionDeleted, onFileChanged } =
    createSessionHooks({
      projectDir,
      log,
      currentProfile,
      shell,
      hookEnabled,
      editedFiles,
      pendingToolChanges,
      changedFilesStore,
    })

  return {
    toolBefore,
    toolAfter,
    shellEnv: createShellEnvHook({ projectDir, currentProfile, eccRoot }),
    permissionDecision: createPermissionHook(log),
    compactionText: createCompactionHook(editedFiles, eccRoot),
    onSessionCreated,
    onSessionIdle,
    onSessionDeleted,
    onFileChanged,
    loadToolRunners: () => loadToolRunners(log),
  }
}

export async function createEccRuntime(options: EccRuntimeOptions): Promise<EccRuntime> {
  const { projectDir, log } = options
  const state = createRuntimeState()
  const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
  const shell = options.shell ?? getShell()

  const changedFilesStore = await loadChangedFilesStore(projectDir, log)
  const trackerRoot = findEccRootDir(resolvedRuntimeDir, ECC_ROOT_PROBES.skillTracker)
  const eccRoot =
    findEccRootDir(resolvedRuntimeDir, ECC_ROOT_PROBES.resolver) ??
    findEccRootDir(resolvedRuntimeDir, ECC_ROOT_PROBES.root)
  const recordSkillRun = await loadSkillTracker(trackerRoot, log)

  const hooks = createRuntimeHooks({
    ...state,
    projectDir,
    log,
    shell,
    currentProfile,
    hookEnabled: createHookGate(currentProfile),
    eccRoot,
    changedFilesStore,
    recordSkillRun,
    sessionDir: createSessionDirResolver(projectDir, state.sessionDirs, options.resolveSessionDir),
  })

  return {
    projectDir,
    currentProfile,
    ...hooks,
    dispose: () => disposeRuntime(state.editedFiles, state.pendingToolChanges, state.sessionDirs),
  }
}
