/**
 * Minimal, dependency-free schema builder for ECC's OpenCode tools.
 *
 * OpenCode v2 takes plain JSON Schema for plugin tool input, while v1 requires
 * zod shapes built from `@opencode-ai/plugin/tool`. Depending on either SDK at
 * runtime meant `~/.config/opencode` needed a node_modules install before the
 * tools could load. This builder records the handful of zod calls ECC's tools
 * use (string/number/boolean/enum, optional, describe), emits JSON Schema for
 * v2, and can replay the same calls onto zod when a v1 host provides it.
 */

type Kind = "string" | "number" | "boolean" | "enum"

export interface FieldSpec {
  readonly kind: Kind
  readonly values?: readonly string[]
  readonly optional: boolean
  readonly description?: string
}

export class Field {
  constructor(readonly spec: FieldSpec) {}

  optional(): Field {
    return new Field({ ...this.spec, optional: true })
  }

  describe(description: string): Field {
    return new Field({ ...this.spec, description })
  }
}

export const s = {
  string: () => new Field({ kind: "string", optional: false }),
  number: () => new Field({ kind: "number", optional: false }),
  boolean: () => new Field({ kind: "boolean", optional: false }),
  enum: (values: readonly string[]) => new Field({ kind: "enum", values: [...values], optional: false }),
}

export type ToolArgs = Record<string, Field>

/** Execution context shared by the v1 and v2 adapters. */
export interface ToolRunContext {
  readonly directory: string
  readonly worktree: string
  readonly sessionID?: string
}

export interface EccToolDefinition {
  /** v2 name, registered under the `ecc` namespace (e.g. `run_tests`). */
  readonly name: string
  /** v1 name, kept for configs that reference the old hyphenated ids. */
  readonly v1Name: string
  readonly description: string
  readonly args: ToolArgs
  readonly execute: (args: Record<string, any>, context: ToolRunContext) => Promise<string>
}

export function defineTool(definition: EccToolDefinition): EccToolDefinition {
  return definition
}

export function toJsonSchema(args: ToolArgs): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, field] of Object.entries(args)) {
    const { kind, values, optional, description } = field.spec
    const property: Record<string, unknown> =
      kind === "enum" ? { type: "string", enum: values } : { type: kind }
    if (description) property.description = description
    properties[key] = property
    if (!optional) required.push(key)
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/** Replay the recorded fields onto a zod instance (v1 `tool.schema`). */
export function toZodShape(args: ToolArgs, z: any): Record<string, unknown> {
  const shape: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(args)) {
    const { kind, values, optional, description } = field.spec
    let schema = kind === "enum" ? z.enum(values) : z[kind]()
    if (optional) schema = schema.optional()
    if (description) schema = schema.describe(description)
    shape[key] = schema
  }
  return shape
}
