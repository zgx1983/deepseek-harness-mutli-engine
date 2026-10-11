import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, expect, it } from 'vitest'
import { startTeamToolBridge } from '../src/team-tool-bridge.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = await ctx.agentLoop.create(SessionId('team-bridge'), {})
  return { ctx, agent }
}

it('exposes only scoped Team tools, logs their calls and rejects calls outside a turn', async () => {
  const { ctx, agent } = await harness()
  const callers: string[] = []
  for (const name of ['team_task_get', 'list_agents', 'list_teammate_models', 'unrelated']) {
    ctx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false },
        render: () => [{ type: 'text', text: 'team-result' }] },
      execute: async (_args, exec) => { callers.push(exec.agent!.id); return {} },
    }))
  }
  const bridge = await startTeamToolBridge(agent, new AbortController().signal)
  expect(bridge).toBeDefined()
  if (bridge === undefined) throw new Error('expected Team bridge')
  cleanups.push(() => bridge.close())
  expect((await fetch(bridge.url, { method: 'POST' })).status).toBe(403)
  const client = new Client({ name: 'bridge-test', version: '1' })
  cleanups.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: bridge.authorization } },
  }) as Transport)
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['list_agents', 'list_teammate_models', 'team_task_get'])
  expect((await client.callTool({ name: 'list_agents' })).isError).toBe(true)
  const finish = bridge.beginTurn(new AbortController().signal)
  expect((await client.callTool({ name: 'list_agents' })).content).toEqual([{ type: 'text', text: 'team-result' }])
  expect((await client.callTool({ name: 'unrelated' })).isError).toBe(true)
  await finish()
  expect((await client.callTool({ name: 'list_agents' })).isError).toBe(true)
  expect(callers).toEqual([agent.id])
  const events = agent.session.snapshotEvents().filter(event => event.type === 'engine/item-settled')
  expect(events.map(event => event.data.category)).toEqual(['harness-tool-catalog', 'harness-tool-call', 'harness-tool-result'])
  expect(JSON.stringify(events)).not.toContain(bridge.authorization)
  await client.close()
  await bridge.close()
  await expect(fetch(bridge.url)).rejects.toThrow()
})

it('does not acquire a listener when the scope has no Team tools', async () => {
  const { agent } = await harness()
  expect(await startTeamToolBridge(agent, new AbortController().signal)).toBeUndefined()
})

it('exposes the scoped execution channel when the session owns one', async () => {
  const { ctx, agent } = await harness()
  const calls: string[] = []
  for (const name of ['task_execution', 'personal_assistant', 'unrelated']) {
    ctx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false },
        render: () => [{ type: 'text', text: `${name}-result` }] },
      execute: async () => { calls.push(name); return {} },
    }))
  }
  const bridge = await startTeamToolBridge(agent, new AbortController().signal)
  expect(bridge).toBeDefined()
  if (bridge === undefined) throw new Error('expected execution bridge')
  cleanups.push(() => bridge.close())
  const client = new Client({ name: 'bridge-execution', version: '1' })
  cleanups.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: bridge.authorization } },
  }) as Transport)
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['task_execution'])
  expect((await client.callTool({ name: 'task_execution' })).isError).toBe(true)
  const finish = bridge.beginTurn(new AbortController().signal)
  expect((await client.callTool({ name: 'task_execution' })).content).toEqual([{ type: 'text', text: 'task_execution-result' }])
  expect((await client.callTool({ name: 'personal_assistant' })).isError).toBe(true)
  await finish()
  expect(calls).toEqual(['task_execution'])
})

it('starts for an execution-only scope without Team tools', async () => {
  const { ctx, agent } = await harness()
  ctx.tools.register(defineTool({ name: 'task_execution', description: 'scoped execution channel', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false },
      render: () => [{ type: 'text', text: 'execution-result' }] },
    execute: async () => ({}),
  }))
  const bridge = await startTeamToolBridge(agent, new AbortController().signal)
  expect(bridge).toBeDefined()
  if (bridge === undefined) throw new Error('expected execution bridge')
  cleanups.push(() => bridge.close())
})

it('cancels and drains admitted calls before closing the owning turn', async () => {
  const { ctx, agent } = await harness()
  let started!: () => void
  const admitted = new Promise<void>((resolve) => { started = resolve })
  let drained = false
  ctx.tools.register(defineTool({ name: 'team_task_get', description: 'cancellable Team task', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false },
      render: () => [{ type: 'text', text: 'cancelled' }] },
    execute: async (_args, exec) => {
      started()
      await new Promise<void>((resolve) => {
        if (exec.signal.aborted) resolve()
        else exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      drained = true
      return {}
    },
  }))
  const bridge = await startTeamToolBridge(agent, new AbortController().signal)
  if (bridge === undefined) throw new Error('expected Team bridge')
  cleanups.push(() => bridge.close())
  const client = new Client({ name: 'bridge-cancellation', version: '1' })
  cleanups.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: bridge.authorization } },
  }) as Transport)
  const finish = bridge.beginTurn(new AbortController().signal)
  const call = client.callTool({ name: 'team_task_get' })
  await admitted
  await finish()
  await call
  expect(drained).toBe(true)
  expect((await client.callTool({ name: 'team_task_get' })).isError).toBe(true)
  const nextTurn = bridge.beginTurn(new AbortController().signal)
  await nextTurn()
  await bridge.close()
  await bridge.close()
})
