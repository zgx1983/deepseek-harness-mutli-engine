/** Cordis provider for the Claude main conversation engine. */
import type {} from '@deepseek-ai/dsh-attachment'
import { AgentEngineId } from '@deepseek-ai/dsh-agent'
import { registerEngineSubagentProvider } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_DISPOSE_GRACE_MS } from './run.ts'
import { registerClaudeEngine, type ClaudeEngineConfig } from './engine.ts'

export const name = 'main-engine-claude'
export const inject = ['agents', 'llm', 'credentials', 'subprocess', 'attachments']

/** Deployment settings for the main conversation engine. */
export type Config = ClaudeEngineConfig
const reasoningFields = {
  reasoningEfforts: z.dict(z.union(['low', 'medium', 'high', 'xhigh', 'max', z.const(null)])),
  defaultReasoningEffort: z.string().min(1),
}

export const Config: z<Config> = z.object({
  pathToClaudeCodeExecutable: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  providers: z.dict(z.object({
    ...reasoningFields, models: z.dict(z.object(reasoningFields)),
    opusModel: z.string().min(1), sonnetModel: z.string().min(1),
    haikuModel: z.string().min(1), subagentModel: z.string().min(1),
  })),
  env: z.dict(z.string()).default({}),
  maxActivityCharacters: z.number().min(1).step(1).default(65_536),
  activityUpdateIntervalMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(100),
  startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  teamToolTimeoutMs: z.number().min(1000).max(MAX_TIMER_DELAY_MS).step(1).default(3_660_000),
  interruptTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
  disposeGraceMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_DISPOSE_GRACE_MS),
})

/**
 * Register the main conversation engine for this plugin lifetime.
 * @param ctx - injected engine registry, endpoint, credential and subprocess services.
 * @param config - deployment defaults; explicit session selections take precedence.
 */
export function apply(ctx: Context, config: Config): void {
  registerClaudeEngine(ctx, config)
  ctx.inject(['subagents'], (scope) => {
    registerEngineSubagentProvider(scope, 'engine:claude', AgentEngineId('claude'))
  })
}
