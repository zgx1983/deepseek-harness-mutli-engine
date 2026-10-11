/** Human model commands route through the same selection service as the GUI picker. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId, type CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { ModelCatalog, SessionSelectModelRequest, SessionSelectModelValue } from './types.ts'

/** Callbacks owned by the Session Controller. */
export interface ModelCommandServices {
  /** List models routable by the receiving session's engine. */
  catalog(engineId?: string): Promise<ModelCatalog>
  /** Read the session-local selected provider. */
  currentProvider(agent: Agent): string
  /** Validate and durably record selection through serialized admission. */
  select(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>
}

/**
 * Create the model-list and model-switch human command.
 * @param services - session-local catalog and selection operations.
 * @returns a definition whose input is never forwarded as a model prompt.
 */
export function modelCommand(services: ModelCommandServices): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-session-controller/model'),
    name: 'model', description: 'List configured models or select a provider and model for this session',
    input: { hint: '[provider] <model>' },
    handler: async ({ agent, rawInput }) => {
      const args = rawInput.trim().split(/\s+/u).filter(Boolean)
      if (args.length === 0) {
        const catalog = await services.catalog(agent.executionEngineId)
        const rows = catalog.groups.flatMap(group => group.models.map(model => `${group.id} ${model.id}`))
        return { kind: 'success', text: ['/model [provider] <model>', ...rows,
          ...catalog.failures.map(failure => `${failure.id}: ${failure.message}`)].join('\n') }
      }
      if (args.length > 2) return { kind: 'error', text: 'Use /model [provider] <model>.' }
      const provider = args.length === 1 ? services.currentProvider(agent) : args[0]
      const model = args.at(-1)
      if (provider === undefined || model === undefined) return { kind: 'error', text: 'Provider and model are required.' }
      const result = await services.select({ sessionId: agent.session.id, provider, model })
      return { kind: 'success', text: `${result.selected.provider} ${result.selected.model}` }
    },
  }
}
