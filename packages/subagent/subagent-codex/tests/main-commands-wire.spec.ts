import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodexMainWire } from '../src/main-wire.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function server(skills = [{ name: 'audit', description: 'Audit a change', path: '/workspace/.agents/skills/audit/SKILL.md', enabled: true }]) {
  const input = new PassThrough()
  const requests: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = []
  const notify = (method: string, params: Record<string, unknown>) => input.write(`${JSON.stringify({ method, params })}\n`)
  let pending = ''
  let turnCounter = 0
  const output = new Writable({ write(chunk, _encoding, done) {
    pending += String(chunk)
    for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
      const message = JSON.parse(pending.slice(0, newline)) as typeof requests[number]
      pending = pending.slice(newline + 1)
      requests.push(message)
      if (message.id === undefined) continue
      const result = message.method === 'thread/start' || message.method === 'thread/resume'
        ? { thread: { id: 'commands-thread', ephemeral: false } }
        : message.method === 'skills/list' ? { data: [{ skills, errors: [] }] }
          : message.method === 'collaborationMode/list' ? { data: [
            { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
            { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
          ] }
            : message.method === 'review/start' ? { reviewThreadId: 'commands-thread', turn: { id: 'review-turn' } }
              : message.method === 'turn/start' ? { turn: { id: `turn-${++turnCounter}` } } : {}
      input.write(`${JSON.stringify({ id: message.id, result })}\n`)
      if (message.method === 'turn/start' || message.method === 'review/start' || message.method === 'thread/compact/start') {
        const turnId = message.method === 'review/start' ? 'review-turn' : `turn-${turnCounter}`
        if (message.method === 'review/start') notify('item/completed', { threadId: 'commands-thread', turnId,
          item: { type: 'exitedReviewMode', id: 'review-item', review: 'review-result' } })
        notify('turn/completed', { threadId: 'commands-thread', turn: { id: turnId, status: 'completed' } })
      }
    }
    done()
  } })
  const turn: Record<string, unknown> = { model: 'first', effort: 'low' }
  const catalogs: unknown[] = []
  let changed = 0
  const wire = CodexMainWire.overStreams(input, output, { thread: {}, turn, startupTimeoutMs: 10_000,
    onRequest: async () => null, onCommandCatalog: (catalog) => { catalogs.push(catalog) },
    onCommandsChange: () => { changed++ },
  })
  cleanups.push(() => { wire.close(); input.destroy(); output.destroy() })
  wire.start()
  return { wire, requests, notify, turn, catalogs, changed: () => changed }
}

it('discovers enabled skills, submits native skill paths and invalidates changed commands', async () => {
  const { wire, requests, notify, catalogs, changed } = server([
    { name: 'audit', description: 'Audit a change', path: '/workspace/audit/SKILL.md', enabled: true },
    { name: 'disabled', description: 'Disabled', path: '/workspace/disabled/SKILL.md', enabled: false },
  ])
  const signal = new AbortController().signal
  await wire.initialize(signal)
  await wire.startThread('/workspace', signal)
  expect((await wire.listSkills(signal)).map(skill => skill.name)).toEqual(['audit'])
  await wire.runTurn(['/audit changed files'], signal)
  expect(requests.find(request => request.method === 'turn/start')?.params?.input).toEqual([
    { type: 'text', text: '$audit changed files', text_elements: [] },
    { type: 'skill', name: 'audit', path: '/workspace/audit/SKILL.md' },
  ])
  expect(catalogs).toHaveLength(2)
  notify('skills/changed', {})
  expect(changed()).toBe(1)
  await expect(wire.runTurn(['/missing'], signal)).rejects.toThrow('Unsupported Codex prompt command')
})

it('rejects ambiguous enabled skill names', async () => {
  const skill = { name: 'audit', description: 'Audit', path: '/a/SKILL.md', enabled: true }
  const { wire } = server([skill, { ...skill, path: '/b/SKILL.md' }])
  const signal = new AbortController().signal
  await wire.initialize(signal)
  await wire.startThread('/workspace', signal)
  await expect(wire.listSkills(signal)).rejects.toThrow('Ambiguous Codex skill command')
})

it('reviews inline with the selected model and effort, and returns review text', async () => {
  const { wire, requests, turn } = server()
  const signal = new AbortController().signal
  await wire.initialize(signal)
  await wire.startThread('/workspace', signal)
  turn.model = 'second'
  turn.effort = 'high'
  const chunks: StreamChunk[] = []
  await wire.runTurn(['/review check cancellation'], signal, (chunk) => { chunks.push(chunk) })
  expect(requests.find(request => request.method === 'thread/resume')?.params).toMatchObject({
    threadId: 'commands-thread', model: 'second', reasoningEffort: 'high',
  })
  expect(requests.find(request => request.method === 'review/start')?.params).toEqual({
    threadId: 'commands-thread', delivery: 'inline', target: { type: 'custom', instructions: 'check cancellation' },
  })
  expect(wire.collectOutput()).toEqual([{ type: 'text', text: 'review-result' }])
  expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'review-result')).toBe(true)
})

it('lists native collaboration modes and carries the selected mode on subsequent turns', async () => {
  const { wire, requests } = server()
  const signal = new AbortController().signal
  await wire.initialize(signal)
  await wire.startThread('/workspace', signal)

  expect(await wire.listCollaborationModes(signal)).toEqual(['plan', 'default'])
  await wire.runTurn(['plain prompt'], signal)
  expect(requests.find(request => request.method === 'turn/start')?.params)
    .not.toHaveProperty('collaborationMode')

  wire.setCollaborationMode('plan')
  await wire.runTurn(['plan this'], signal)
  expect(requests.filter(request => request.method === 'turn/start').at(-1)?.params).toMatchObject({
    collaborationMode: { mode: 'plan', settings: { model: 'first', reasoningEffort: 'low' } },
  })

  wire.setCollaborationMode('default')
  await wire.runTurn(['back to default'], signal)
  expect(requests.filter(request => request.method === 'turn/start').at(-1)?.params).toMatchObject({
    collaborationMode: { mode: 'default', settings: { model: 'first', reasoningEffort: 'low' } },
  })
})
