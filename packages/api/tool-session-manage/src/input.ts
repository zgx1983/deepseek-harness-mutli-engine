/**
 * Model argument and output schemas for the session-manage tools.
 *
 * @module @deepseek-ai/dsh-tool-session-manage/input
 */

/** Arguments for `list_models`. */
export interface ListModelsArgs {
  readonly engine_id?: string
}

/** Arguments for `session_create`. */
export interface SessionCreateArgs {
  readonly workspace_id?: string
  readonly cwd?: string
  readonly engine_id?: string
  readonly provider?: string
  readonly model?: string
  readonly title?: string
}

/** One registered project workspace in a `list_projects` result. */
export interface ProjectEntry {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionCount: number
}

/** Canonical `list_projects` value. */
export interface ProjectsValue {
  readonly projects: ProjectEntry[]
}

/** One engine entry in a `list_engines` result. */
export interface EngineEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Canonical `list_engines` value. */
export interface EnginesValue {
  readonly engines: EngineEntry[]
}

/** One model entry in a `list_models` group. */
export interface ModelEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One provider group in a `list_models` result. */
export interface ProviderGroupEntry {
  readonly provider: string
  readonly name: string
  readonly models: ModelEntry[]
}

/** Canonical `list_models` value. */
export interface ModelsValue {
  readonly default: { readonly provider: string; readonly model: string }
  readonly groups: ProviderGroupEntry[]
}

/** The selected model recorded by `session_create`. */
export interface CreatedModel {
  readonly provider: string
  readonly model: string
}

/** Canonical `session_create` value. */
export interface SessionCreatedValue {
  readonly sessionId: string
  readonly workspaceId?: string
  readonly engineId?: string
  readonly model?: CreatedModel
  readonly title?: string
  readonly reused: boolean
}

const listModelsParameters = {
  engine_id: {
    type: 'string',
    description: 'Engine id from list_engines. The listing is engine-relative: only providers whose endpoints serve that engine are returned. Omit for the unfiltered deployment catalog.',
  },
} as const

const sessionCreateParameters = {
  workspace_id: {
    type: 'string',
    description: 'Target project workspace id from list_projects. Provide exactly one of workspace_id or cwd.',
  },
  cwd: {
    type: 'string',
    description: 'Target absolute directory path for a session outside registered projects. Provide exactly one of workspace_id or cwd.',
  },
  engine_id: {
    type: 'string',
    description: 'Engine id from list_engines. Omit for the deployment default engine.',
  },
  provider: {
    type: 'string',
    description: 'Provider id from list_models. Provide together with model.',
  },
  model: {
    type: 'string',
    description: 'Model id under provider. Provide together with provider.',
  },
  title: {
    type: 'string',
    description: 'Session title. Omit to keep the generated default.',
  },
} as const

const projectEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string', required: true },
    path: { type: 'string', required: true },
    title: { type: 'string', required: true },
    sessionCount: { type: 'integer', required: true },
  },
} as const

const engineEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string' },
  },
} as const

const modelEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string' },
  },
} as const

const providerGroupSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    name: { type: 'string', required: true },
    models: { type: 'array', required: true, items: modelEntrySchema },
  },
} as const

const listProjectsOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projects: { type: 'array', required: true, items: projectEntrySchema },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const listEnginesOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      engines: { type: 'array', required: true, items: engineEntrySchema },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const listModelsOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      default: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      groups: { type: 'array', required: true, items: providerGroupSchema },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const sessionCreateOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', required: true },
      workspaceId: { type: 'string' },
      engineId: { type: 'string' },
      model: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      title: { type: 'string' },
      reused: { type: 'boolean', required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/** Model schemas and output renderers for every session-manage tool. */
export const toolInput = {
  listModelsParameters,
  sessionCreateParameters,
  listProjectsOutput,
  listEnginesOutput,
  listModelsOutput,
  sessionCreateOutput,
}
