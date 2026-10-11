import { PassThrough, Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { CodexMainWire } from '../src/main-wire.ts'

it.each([
  { pages: [{ data: [{ model: 'a' }], nextCursor: 'page-two' }, { data: [{ model: 'b' }], nextCursor: null }], error: undefined },
  { pages: [{ data: [{ model: 'a' }], nextCursor: null }], error: 'did not load' },
  { pages: [{ data: [{ model: 'a' }], nextCursor: 'repeat' }, { data: [{ model: 'b' }], nextCursor: 'repeat' }], error: 'repeated a cursor' },
  { pages: [{ data: 'invalid', nextCursor: null }], error: 'Invalid Codex model catalog entries' },
])('verifies native catalog pages at initialization: $error', async ({ pages, error }) => {
  const input = new PassThrough()
  const requests: string[] = []
  let pending = ''
  const output = new Writable({ write(chunk, _encoding, done) {
    pending += String(chunk)
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      const message = JSON.parse(line) as { id?: number; method: string }
      requests.push(message.method)
      if (message.id !== undefined) {
        input.write(`${JSON.stringify({ id: message.id, result: message.method === 'initialize' ? {} : pages.shift() })}\n`)
      }
      newline = pending.indexOf('\n')
    }
    done()
  } })
  const wire = CodexMainWire.overStreams(input, output, { expectedModelIds: ['a', 'b'], thread: {},
    startupTimeoutMs: 1000, onRequest: async () => null })
  wire.start()
  try {
    const initialize = wire.initialize(AbortSignal.timeout(1000))
    if (error === undefined) await initialize
    else await expect(initialize).rejects.toThrow(error)
    expect(requests.slice(0, 3)).toEqual(['initialize', 'initialized', 'model/list'])
  } finally { wire.close(); input.destroy(); output.destroy() }
})
