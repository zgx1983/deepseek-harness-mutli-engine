/** Cordis provider for the Codex main conversation engine. */
import type {} from '@deepseek-ai/dsh-attachment'
import { AgentEngineId } from '@deepseek-ai/dsh-agent'
import { registerEngineSubagentProvider } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CODEX_PERMISSION_MODES, DEFAULT_CODEX_PERMISSION_MODE, DEFAULT_DISPOSE_GRACE_MS } from './run.ts'
import { DEFAULT_CATALOG_INSTRUCTIONS, DEFAULT_CATALOG_TRUNCATION_TOKEN_LIMIT } from './model-catalog.ts'
import { CodexProviderOptionsSchema, DEFAULT_AUTO_COMPACT_CONTEXT_RATIO } from './provider-config.ts'
import { DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES } from './user-config.ts'
import { registerCodexEngine, type CodexEngineConfig } from './engine.ts'

export const name = 'main-engine-codex'
export const inject = ['agents', 'llm', 'credentials', 'subprocess', 'attachments']

/** Deployment settings for the main conversation engine. */
export type Config = CodexEngineConfig
export const Config: z<Config> = z.object({
  catalogInstructions: z.string().min(1).default(DEFAULT_CATALOG_INSTRUCTIONS),
  catalogTruncationTokenLimit: z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(DEFAULT_CATALOG_TRUNCATION_TOKEN_LIMIT),
  providers: z.dict(CodexProviderOptionsSchema),
  provider: z.string().min(1),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  mirrorUserInstructions: z.boolean().default(true),
  projectDocFallbackFilenames: z.array(z.string().min(1)).default([...DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES]),
  autoCompactContextRatio: z.number().min(0.01).max(1).default(DEFAULT_AUTO_COMPACT_CONTEXT_RATIO),
  permissionMode: z.union([...CODEX_PERMISSION_MODES]).default(DEFAULT_CODEX_PERMISSION_MODE),
  activityUpdateIntervalMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).step(1).default(100),
  maxActivityCharacters: z.number().min(1).step(1).default(65_536),
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
  registerCodexEngine(ctx, config)
  ctx.inject(['subagents'], (scope) => {
    registerEngineSubagentProvider(scope, 'engine:codex', AgentEngineId('codex'))
  })
}
