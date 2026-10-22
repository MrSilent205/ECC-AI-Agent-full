/**
 * Shared contracts for the ECC OpenCode hook runtime.
 *
 * The hook factories, the runtime composition root, and the plugin surface
 * agree on these types without importing each other's implementation.
 */

export type HookProfile = "minimal" | "standard" | "strict"
export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFn = (level: LogLevel, message: string) => void

export type ShellFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown> & { text(): Promise<string> }

export interface ToolArgs {
  filePath?: unknown
  file_path?: unknown
  path?: unknown
  command?: unknown
  [key: string]: unknown
}

export interface PermissionDecision {
  status: "ask" | "allow" | "deny"
  message: string
}

export interface ToolRunners {
  changedFilesDescription: string
  dependencyAnalyzerDescription: string
  executeChangedFiles: (args: any, projectDir: string) => Promise<string>
  executeDependencyAnalyzer: (args: any, projectDir: string) => Promise<string>
}

export interface EccRuntimeOptions {
  /** Project root used to resolve relative paths and detect project markers. */
  projectDir: string
  log: LogFn
  /** Resolve the working directory of a session (falls back to projectDir). */
  resolveSessionDir: (sessionID: string) => Promise<string>
  /** Optional shell runtime (Bun `$`) supplied by the host plugin input. */
  shell?: ShellFn
}

export interface EccRuntime {
  projectDir: string
  currentProfile: HookProfile
  toolBefore(
    toolName: string,
    input: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void>
  toolAfter(
    toolName: string,
    input: unknown,
    output: unknown,
    sessionID: string | undefined,
    callID: string | undefined
  ): Promise<void>
  shellEnv(cwd: string | undefined, env: Record<string, string>): void
  permissionDecision(
    action: string,
    resources: string | string[] | undefined | null
  ): PermissionDecision
  compactionText(): string
  onSessionCreated(details: { directory?: string }): void
  onSessionIdle(): Promise<void>
  onSessionDeleted(): void
  onFileChanged(file: string, kind: string): void
  loadToolRunners(): Promise<ToolRunners | undefined>
  dispose(): void
}

/** Lazily loaded changed-files store. */
export type ChangedFilesStore = typeof import("../lib/changed-files-store.ts")

/** Decides whether a hook runs under the active profile. */
export type HookGate = (hookId: string, required?: HookProfile | HookProfile[]) => boolean
