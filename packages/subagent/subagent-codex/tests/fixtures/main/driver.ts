/** Verify the generated native catalog, model switching and resume through the shipped Loader. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AgentEngineId, installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const patch = process.argv[2]
if (patch === undefined) throw new Error('Codex acceptance needs its patch')
const workspace = join(process.cwd(), 'workspace')
await mkdir(workspace)
const ctx = await bootProductionProfile({ binName: 'codex-main-loader-acceptance', profile: 'headless', overlayPaths: [patch] })
try {
  let starts = 0
  let nativeHome: string | undefined
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = (spec) => {
    starts += 1
    nativeHome = spec.env?.CODEX_HOME
    return spawn(spec)
  }
  const handle = await ctx.agents.create({ sessionId: SessionId('codex-acceptance'), engineId: AgentEngineId('codex'),
    meta: { cwd: workspace }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  const errors: string[] = []
  ctx.on('agent/error', ({ agent, error }) => {
    if (agent.id === handle.agent.id) errors.push(error instanceof Error ? error.message : String(error))
  })
  const token = `DSH_CODEX_${randomUUID()}`
  const send = async (text: string) => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    assert.deepEqual(errors, [])
  }
  await handle.agent.prepareExecution?.(AbortSignal.timeout(35000))
  assert.equal(starts, 1)
  assert.ok(nativeHome)
  const contents = await readFile(join(nativeHome, 'models.json'), 'utf8')
  const catalog = JSON.parse(contents) as { models: Array<{ slug: string }> }
  const record = handle.agent.session.snapshotEvents().find(event =>
    event.type === 'engine/item-settled' && event.data.category === 'model-catalog')
  assert.ok(record?.type === 'engine/item-settled')
  const payload = record.data.payload
  assert.ok(payload !== null && typeof payload === 'object' && 'contents' in payload)
  assert.equal(payload.contents, contents)
  assert.deepEqual(catalog.models.map((entry: { slug: string }) => entry.slug), ['deepseek-flash', 'deepseek-v4-pro'])
  console.log(JSON.stringify({ stage: 'native-catalog-loaded', models: catalog.models.map(entry => entry.slug) }))
  await send(`Remember the exact token ${token}. Reply with only ACK. Do not use tools.`)
  installModelSelection(handle.agent.ctx, { current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, assembled: undefined })
  await send('What exact token did I ask you to remember? Reply with the token only. Do not use tools.')
  assert.equal(starts, 1)
  const messages = handle.agent.session.snapshotEvents().flatMap(event => event.type === 'assistant/message' ? [event.data] : [])
  assert.match(JSON.stringify(messages.at(-1)?.message.content), new RegExp(token))
  const id = SessionId(handle.agent.id)
  await handle.dispose()
  const nativeFiles = await readdir(join(nativeHome, 'sessions'), { recursive: true })
  const rollout = nativeFiles.find(path => path.endsWith('.jsonl'))
  assert.ok(rollout)
  const nativeTurns = (await readFile(join(nativeHome, 'sessions', rollout), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { type: string; payload?: { model?: string } })
    .filter(record => record.type === 'turn_context').map(record => record.payload?.model)
  assert.ok(nativeTurns.includes('deepseek-flash'))
  assert.ok(nativeTurns.includes('deepseek-v4-pro'))
  const resumed = await ctx.agents.resume({ engineId: AgentEngineId('codex'), resumeSessionId: id,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  })
  resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text:
    'Repeat the exact token remembered earlier. Reply with the token only. Do not use tools.' }], source: { kind: 'user' } }))
  await resumed.agent.whenIdle()
  assert.deepEqual(errors, [])
  const last = resumed.agent.session.snapshotEvents().flatMap(event => event.type === 'assistant/message' ? [event.data] : []).at(-1)
  assert.match(JSON.stringify(last?.message.content), new RegExp(token))
  assert.equal(starts, 2)
  await resumed.dispose()
  console.log(JSON.stringify({ turns: 3, nativeCatalog: true, modelSwitch: true, resumed: true, errors: [] }))
} finally { await ctx.fiber.dispose() }
