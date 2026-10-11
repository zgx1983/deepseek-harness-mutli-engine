/**
 * Session-manage tool execution against the Host session and workspace services.
 *
 * @module @deepseek-ai/dsh-tool-session-manage/operations
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionCreateValue,
  SessionSelectModelValue,
} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  EnginesValue,
  ListModelsArgs,
  ModelsValue,
  ProjectsValue,
  SessionCreateArgs,
  SessionCreatedValue,
} from './input.ts'
import { SessionManageError, serviceBoundary } from './service-boundary.ts'

/** Every visible project workspace, trimmed to the fields a model acts on. */
async function executeListProjects(ctx: Context, exec: ToolRunContext): Promise<ProjectsValue> {
  return serviceBoundary.call(ctx, exec.signal, 'list_projects', () => ({
    projects: ctx.workspaceRegistry.list().map(workspace => ({
      workspaceId: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionCount: workspace.sessionIds.length,
    })),
  }))
}

/** Every registered execution engine, trimmed to id, name, and description. */
async function executeListEngines(ctx: Context, exec: ToolRunContext): Promise<EnginesValue> {
  return serviceBoundary.call(ctx, exec.signal, 'list_engines', () => ({
    engines: ctx.sessionController.engineCatalog().engines.map(engine => ({
      id: engine.id,
      name: engine.name,
      ...engine.description === undefined ? {} : { description: engine.description },
    })),
  }))
}

/** The model catalog, optionally narrowed to one engine's routable providers. */
async function executeListModels(ctx: Context, args: ListModelsArgs, exec: ToolRunContext): Promise<ModelsValue> {
  return serviceBoundary.call(ctx, exec.signal, 'list_models', async () => {
    const engineId = requireNonEmpty('engine_id', args.engine_id)
    const catalog = await ctx.sessionController.modelCatalog(engineId)
    return {
      default: { provider: catalog.default.provider, model: catalog.default.model },
      groups: catalog.groups.map(group => ({
        provider: group.id,
        name: group.name,
        models: group.models.map(model => ({
          id: model.id,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
        })),
      })),
    }
  })
}

/**
 * Create one ordinary session in the caller-named project, reusing a matching
 * blank session like the workspace "new session" affordance does, then fix its
 * optional engine, model, and title before the first user message.
 */
async function executeSessionCreate(ctx: Context, args: SessionCreateArgs, exec: ToolRunContext): Promise<SessionCreatedValue> {
  return serviceBoundary.call(ctx, exec.signal, 'session_create', async () => {
    const target = resolveCreateTarget(ctx, args)
    const engineId = requireNonEmpty('engine_id', args.engine_id)
    const provider = requireNonEmpty('provider', args.provider)
    const model = requireNonEmpty('model', args.model)
    const title = requireNonEmpty('title', args.title)
    if ((provider === undefined) !== (model === undefined)) {
      throw new SessionManageError('provider and model must be provided together', 'SESSION_MANAGE_INVALID_ARGS')
    }
    const created = await createSession(ctx, target, engineId, exec.signal)
    let selected: SessionSelectModelValue | undefined
    if (provider !== undefined && model !== undefined) {
      selected = await ctx.sessionController.selectModel({ sessionId: created.value.sessionId, provider, model })
    }
    let acceptedTitle: string | undefined
    if (title !== undefined) {
      acceptedTitle = (await ctx.sessionController.rename({
        sessionId: created.value.sessionId,
        title,
      })).title
    }
    return {
      sessionId: created.value.sessionId,
      ...target.kind === 'workspace' ? { workspaceId: target.workspace.id } : {},
      ...created.value.engineId === undefined ? {} : { engineId: created.value.engineId },
      ...selected === undefined
        ? {}
        : { model: { provider: selected.selected.provider, model: selected.selected.model } },
      ...acceptedTitle === undefined ? {} : { title: acceptedTitle },
      reused: created.reused,
    }
  })
}

/** A validated create location: one registered workspace or one absolute path. */
type CreateTarget =
  | { readonly kind: 'workspace'; readonly workspace: Workspace }
  | { readonly kind: 'cwd'; readonly cwd: string }

function resolveCreateTarget(ctx: Context, args: SessionCreateArgs): CreateTarget {
  const workspaceId = requireNonEmpty('workspace_id', args.workspace_id)
  const cwd = requireNonEmpty('cwd', args.cwd)
  const location: { readonly workspaceId: string } | { readonly cwd: string } | undefined
    = workspaceId !== undefined && cwd === undefined
      ? { workspaceId }
      : workspaceId === undefined && cwd !== undefined
        ? { cwd }
        : undefined
  if (location === undefined) {
    throw new SessionManageError('provide exactly one of workspace_id or cwd', 'SESSION_MANAGE_INVALID_ARGS')
  }
  if ('cwd' in location) {
    if (!isAbsolute(location.cwd)) {
      throw new SessionManageError('cwd must be a non-empty absolute directory path', 'SESSION_MANAGE_INVALID_ARGS')
    }
    return { kind: 'cwd', cwd: location.cwd }
  }
  const workspace = ctx.workspaceRegistry.get(WorkspaceId(location.workspaceId))
  if (workspace === undefined) {
    throw new SessionManageError(
      `"${location.workspaceId}" is not a registered project; call list_projects for the known project ids`,
      'SESSION_MANAGE_PROJECT_NOT_FOUND',
    )
  }
  return { kind: 'workspace', workspace }
}

/** Created-session outcome carrying whether a blank session was adopted. */
interface CreateOutcome {
  readonly value: SessionCreateValue
  readonly reused: boolean
}

async function createSession(
  ctx: Context,
  target: CreateTarget,
  engineId: string | undefined,
  signal: AbortSignal,
): Promise<CreateOutcome> {
  const requestedEngine = engineId === undefined ? {} : { engineId }
  const blank = target.kind === 'workspace'
    ? await findReusableBlankSession(ctx, target.workspace, signal)
    : undefined
  if (blank !== undefined && target.kind === 'workspace') {
    try {
      return {
        value: await ctx.sessionController.create({ sessionId: blank, workspaceId: target.workspace.id, ...requestedEngine }),
        reused: true,
      }
    } catch (error: unknown) {
      if (!serviceBoundary.isRecoverableAdoptionFailure(error)) throw error
    }
  }
  const location = target.kind === 'workspace' ? { workspaceId: target.workspace.id } : { cwd: target.cwd }
  return {
    value: await ctx.sessionController.create({ ...location, ...requestedEngine }),
    reused: false,
  }
}

/**
 * The first blank session already attached to the workspace and not archived,
 * mirroring the Web client's blank-reuse predicate.
 */
async function findReusableBlankSession(
  ctx: Context,
  workspace: Workspace,
  signal: AbortSignal,
): Promise<SessionId | undefined> {
  const { items } = await ctx.sessionController.list({}, signal)
  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  const summary = items.find(item => item.blank
    && item.cwd === workspace.path
    && workspace.sessionIds.includes(item.sessionId)
    && !archived.has(item.sessionId))
  return summary === undefined ? undefined : summary.sessionId
}

function requireNonEmpty(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.trim().length === 0) {
    throw new SessionManageError(`${name} must be non-empty when provided`, 'SESSION_MANAGE_INVALID_ARGS')
  }
  return value
}

/** Execution bodies for every session-manage tool. */
export const operations = {
  executeListProjects,
  executeListEngines,
  executeListModels,
  executeSessionCreate,
}
