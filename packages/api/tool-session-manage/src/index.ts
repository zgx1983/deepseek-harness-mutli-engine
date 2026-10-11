/**
 * Model-facing project, engine, and model catalog tools plus conversational
 * session creation over the Host session and workspace services.
 *
 * @module @deepseek-ai/dsh-tool-session-manage
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { toolInput } from './input.ts'
import { operations } from './operations.ts'
import { presentation } from './presentation.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-session-manage'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt', 'sessionController', 'workspaceRegistry']

const PROMPT_TEXT =
  'When the user names a project, engine, or model by voice, resolve each with list_projects, list_engines, '
  + 'and list_models, then pass the resolved ids to session_create instead of the spoken names. Requests to '
  + 'create or open a user-visible session belong to session_create; reserve teammates for requests that '
  + 'explicitly ask for Agent Teams.'

/** Register the four tools and their shared composition guidance. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:session-manage',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_MANAGE'),
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'list_projects',
    description: 'List every registered project workspace with its id, absolute path, title, and session count.',
    parameters: {},
    output: toolInput.listProjectsOutput,
    isConcurrencySafe: () => true,
    execute: (_args, exec) => operations.executeListProjects(ctx, exec),
    presentCall: presentation.presentListProjectsCall,
  }))

  ctx.tools.register(defineTool({
    name: 'list_engines',
    description: 'List the execution engines a new session can choose, with each engine id and display name.',
    parameters: {},
    output: toolInput.listEnginesOutput,
    isConcurrencySafe: () => true,
    execute: (_args, exec) => operations.executeListEngines(ctx, exec),
    presentCall: presentation.presentListEnginesCall,
  }))

  ctx.tools.register(defineTool({
    name: 'list_models',
    description: 'List the models available to new sessions, grouped by provider with the deployment default.',
    parameters: toolInput.listModelsParameters,
    output: toolInput.listModelsOutput,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeListModels(ctx, args, exec),
    presentCall: presentation.presentListModelsCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_create',
    description: 'Create a new user-visible top-level session in a project, optionally fixing its engine, model, and title before the first message. A matching blank session in the target project is reused. This is not a teammate or child agent.',
    parameters: toolInput.sessionCreateParameters,
    output: {
      ...toolInput.sessionCreateOutput,
      presentationMeta: (_args, value) => value,
    },
    execute: (args, exec) => operations.executeSessionCreate(ctx, args, exec),
    presentCall: presentation.presentSessionCreateCall,
  }))
}
