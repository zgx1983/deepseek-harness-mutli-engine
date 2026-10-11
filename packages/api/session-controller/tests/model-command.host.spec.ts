import { expect, it, vi } from 'vitest'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { modelCommand } from '../src/model-command.ts'

it('lists engine-filtered configured models and switches through session selection', async () => {
  const catalog = vi.fn(async () => ({ default: { provider: 'gateway', model: 'large' },
    routableProviders: ['gateway'], failures: [],
    groups: [{ id: 'gateway', name: 'Gateway', models: [{ id: 'large', name: 'Large' }, { id: 'small', name: 'Small' }] }],
  }))
  const select = vi.fn(async (request: { provider: string; model: string }) => ({ selected: request }))
  const command = modelCommand({ catalog, select, currentProvider: () => 'gateway' })
  const invocation: CommandInvocation = { commandId: 'fixture' as never, agent: { executionEngineId: 'claude', session: { id: SessionId('model-command') } } as never,
    rawInput: '', attachments: [], signal: new AbortController().signal }
  const listing = await command.handler(invocation)
  expect(catalog).toHaveBeenCalledWith('claude')
  expect(listing).toEqual({ kind: 'success', text: '/model [provider] <model>\ngateway large\ngateway small' })
  expect(select).not.toHaveBeenCalled()
  await command.handler({ ...invocation, rawInput: ' small ' })
  expect(select).toHaveBeenLastCalledWith({ sessionId: 'model-command', provider: 'gateway', model: 'small' })
  await command.handler({ ...invocation, rawInput: 'other larger[1m]' })
  expect(select).toHaveBeenLastCalledWith({ sessionId: 'model-command', provider: 'other', model: 'larger[1m]' })
  expect(await command.handler({ ...invocation, rawInput: 'too many arguments' })).toMatchObject({ kind: 'error' })
})

it('records model commands and selection in the receiving session without scheduling a prompt', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('model-command-log'))
  const agent = { id: session.id, session, executionEngineId: 'codex' } as never
  const dispose = ctx.commands.register(modelCommand({
    catalog: async () => ({ default: { provider: 'p', model: 'a' }, routableProviders: ['p'], failures: [],
      groups: [{ id: 'p', name: 'Provider', models: [{ id: 'a', name: 'Model A' }] }] }),
    currentProvider: () => 'p',
    select: async (request) => {
      const selected = { provider: request.provider, model: request.model }
      session.append('model/selection', selected)
      return { selected }
    },
  }))
  try {
    await ctx.commands.execute(agent, '/model', [], new AbortController().signal)
    await ctx.commands.execute(agent, '/model b', [], new AbortController().signal)
    const records: object[] = []
    for (const event of session.snapshotEvents()) {
      if (event.type === 'command/run') records.push({ type: event.type, name: event.data.name, args: event.data.args })
      if (event.type === 'command/done') records.push({ type: event.type, kind: event.data.kind, text: event.data.text })
      if (event.type === 'model/selection') records.push({ type: event.type, ...event.data })
    }
    await expect(JSON.stringify(records, null, 2)).toMatchFileSnapshot('./expected/model-command.txt')
  } finally {
    dispose()
    await ctx.fiber.dispose()
  }
})
