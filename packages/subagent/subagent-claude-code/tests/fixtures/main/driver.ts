/** Inspect actual main-engine persistence through the shipped profile Loader. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentEngineId } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const patch = process.argv[2]
const model = process.env.DSH_CLAUDE_ACCEPTANCE_MODEL
if (patch === undefined || model === undefined) throw new Error('Main acceptance needs its patch and model')
const workspace = join(process.cwd(), 'workspace')
await mkdir(workspace)
const ctx = await bootProductionProfile({
  binName: 'claude-main-loader-acceptance', profile: 'headless', overlayPaths: [patch],
})
try {
  const handle = await ctx.agents.create({ sessionId: SessionId('claude-acceptance'), engineId: AgentEngineId('claude'),
    meta: { cwd: workspace }, agentOptions: { provider: 'acceptance', model },
  })
  const errors: string[] = []
  ctx.on('agent/error', ({ agent, error }) => {
    if (agent.id === handle.agent.id) errors.push(error instanceof Error ? error.message : String(error))
  })
  const send = async (text: string) => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    assert.deepEqual(errors, [])
  }
  await send('Remember the exact token BLUE-PINE-492. Reply with only ACK. Do not use tools.')
  await send('What exact token did I ask you to remember? Reply with the token only. Do not use tools.')
  const events = handle.agent.session.snapshotEvents()
  assert.equal(events.filter(event => event.type === 'user/message').length, 2)
  const messages = events.flatMap(event => event.type === 'assistant/message' ? [event.data] : [])
  assert.equal(messages.length, 2)
  assert.match(JSON.stringify(messages[1]?.message.content), /BLUE-PINE-492/)
  assert.equal(events.filter(event => event.type === 'engine/turn-settled').length, 2)
  assert.ok(events.some(event => event.type === 'engine/item-settled' && event.data.category === 'binding'))
  const id = SessionId(handle.agent.id)
  await handle.dispose()
  const resumed = await ctx.agents.resume({ engineId: AgentEngineId('claude'), resumeSessionId: id,
    agentOptions: { provider: 'acceptance', model },
  })
  resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text:
    'Repeat the exact token remembered earlier. Reply with the token only. Do not use tools.' }], source: { kind: 'user' } }))
  await resumed.agent.whenIdle()
  assert.deepEqual(errors, [])
  const resumedEvents = resumed.agent.session.snapshotEvents()
  const last = resumedEvents.flatMap(event => event.type === 'assistant/message' ? [event.data] : []).at(-1)
  assert.match(JSON.stringify(last?.message.content), /BLUE-PINE-492/)
  assert.equal(resumedEvents.filter(event => event.type === 'engine/item-settled' && event.data.category === 'binding').length, 1)
  await resumed.dispose()
  console.log(JSON.stringify({ turns: 3, persisted: true, resumed: true, errors: [] }))
} finally {
  await ctx.fiber.dispose()
}
