/** Token-usage notifications: turn usage streams and native context-capacity capture. */
import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodexMainWire } from '../src/main-wire.ts'

interface ScriptedNotification {
  readonly method: string
  readonly params?: Record<string, unknown>
}

/**
 * A scripted app-server: answers initialize/thread/turn requests in order and
 * plays one notification script per turn, injecting the serving thread/turn id.
 * @param turnScripts - notifications played after each `turn/start` reply.
 * @returns the protocol streams to hand to the wire.
 */
function startServer(turnScripts: readonly (readonly ScriptedNotification[])[]) {
  const input = new PassThrough()
  let pending = ''
  let turnCounter = 0
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  const write = (message: unknown): void => {
    input.write(`${JSON.stringify(message)}\n`)
  }
  const output = new Writable({
    write(chunk, _encoding, done) {
      pending += String(chunk)
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
        requests.push(message)
        if (message.id !== undefined) {
          if (message.method === 'initialize') write({ id: message.id, result: {} })
          if (message.method === 'thread/start') {
            write({ id: message.id, result: { thread: { id: 'thread-1', ephemeral: false } } })
          }
          if (message.method === 'turn/start' || message.method === 'thread/compact/start') {
            turnCounter += 1
            const turnId = `turn-${turnCounter}`
            write({ id: message.id, result: message.method === 'thread/compact/start' ? {} : { turn: { id: turnId } } })
            for (const notification of turnScripts[turnCounter - 1] ?? []) {
              const params: Record<string, unknown> = { threadId: 'thread-1', ...notification.params }
              const turn = params.turn
              if (turn !== null && typeof turn === 'object') params.turn = { ...turn, id: turnId }
              else params.turnId = turnId
              write({ method: notification.method, params })
            }
          }
        }
        newline = pending.indexOf('\n')
      }
      done()
    },
  })
  return { input, output, requests }
}

const usage = (inputTokens: number): Record<string, unknown> => ({
  inputTokens, outputTokens: 5, cachedInputTokens: 3, cacheWriteInputTokens: 2,
})

const cumulative = (totalTokens: number): Record<string, unknown> => ({
  totalTokens, inputTokens: 10, outputTokens: 5, cachedInputTokens: 3,
})

it('captures turn usage and context capacity, preserving capacity across unreported turns', async () => {
  const { input, output } = startServer([
    [
      { method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: usage(10), total: cumulative(42), modelContextWindow: 128000 } } },
      { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'item-1', text: 'done' } } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ],
    [
      { method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: usage(20), total: cumulative(84) } } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ],
  ])
  const wire = CodexMainWire.overStreams(input, output, {
    thread: {}, startupTimeoutMs: 10_000, onRequest: async () => null,
  })
  wire.start()
  try {
    await wire.initialize(AbortSignal.timeout(10_000))
    await wire.startThread('/workspace', AbortSignal.timeout(10_000))
    expect(wire.contextWindow()).toBeUndefined()

    const first: StreamChunk[] = []
    await wire.runTurn(['hi'], new AbortController().signal, (chunk) => { first.push(chunk) })
    expect(first.filter(chunk => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, sessionTotalTokens: 42 } },
    ])
    expect(wire.collectOutput()).toEqual([{ type: 'text', text: 'done' }])
    expect(wire.contextWindow()).toBe(128000)

    const second: StreamChunk[] = []
    await wire.runTurn(['again'], new AbortController().signal, (chunk) => { second.push(chunk) })
    expect(second.filter(chunk => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 15, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, sessionTotalTokens: 84 } },
    ])
    expect(wire.contextWindow()).toBe(128000)
  } finally {
    wire.close()
    input.destroy()
    output.destroy()
  }
})

it('rejects an invalid context capacity report', async () => {
  const { input, output } = startServer([
    [{ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: usage(10), total: cumulative(42), modelContextWindow: 0 } } }],
  ])
  const wire = CodexMainWire.overStreams(input, output, {
    thread: {}, startupTimeoutMs: 10_000, onRequest: async () => null,
  })
  wire.start()
  try {
    await wire.initialize(AbortSignal.timeout(10_000))
    await wire.startThread('/workspace', AbortSignal.timeout(10_000))
    await expect(wire.runTurn(['hi'], new AbortController().signal))
      .rejects.toThrow('Invalid Codex context window')
  } finally {
    wire.close()
    input.destroy()
    output.destroy()
  }
})


it('accepts an empty compaction reply and waits for the native completion notification', async () => {
  const { input, output, requests } = startServer([[
    { method: 'turn/started', params: { turn: { status: 'inProgress' } } },
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ]])
  const wire = CodexMainWire.overStreams(input, output, { thread: {}, startupTimeoutMs: 1000, onRequest: async () => null })
  wire.start()
  try {
    await wire.initialize(AbortSignal.timeout(1000))
    await wire.startThread('/workspace', AbortSignal.timeout(1000))
    await wire.compact(AbortSignal.timeout(1000))
    expect(requests.find(request => request.method === 'thread/compact/start')?.params).toEqual({ threadId: 'thread-1' })
  } finally {
    wire.close()
    input.destroy()
    output.destroy()
  }
})

it('passes image data URLs alongside text in turn/start input', async () => {
  const { input, output, requests } = startServer([[
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ]])
  const wire = CodexMainWire.overStreams(input, output, { thread: {}, startupTimeoutMs: 1000, onRequest: async () => null })
  wire.start()
  try {
    await wire.initialize(AbortSignal.timeout(1000))
    await wire.startThread('/workspace', AbortSignal.timeout(1000))
    await wire.runTurn([{ type: 'text', text: 'describe' }, { type: 'image', url: 'data:image/png;base64,aGVsbG8=' }], AbortSignal.timeout(1000))
    expect(requests.find(request => request.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: 'describe', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
    ])
  } finally {
    wire.close()
    input.destroy()
    output.destroy()
  }
})
