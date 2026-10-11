import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CodexModelCatalog } from '../src/model-catalog.ts'
import { CodexSharedAppServer, CodexSharedServerHost, type CodexSharedServerSpec } from '../src/shared-server.ts'

interface ScriptedChild {
  handle: SubprocessHandle
  /** Send one protocol frame to the client, as the native child would. */
  send(message: unknown): void
  /** Observed client requests, in wire order. */
  readonly requests: Array<{ method: string; params: Record<string, unknown> }>
  exit(): void
}

/** Fake app-server child over PassThrough streams with scripted JSON-RPC replies. */
function scriptedChild(): ScriptedChild {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  let pending = ''
  let nextThreadId = 0
  let nextTurnId = 0
  inbound.on('data', (chunk: Buffer | string) => {
    pending += String(chunk)
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim().length === 0) continue
      const frame = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> }
      if (frame.id === undefined || frame.method === undefined) continue
      requests.push({ method: frame.method, params: frame.params ?? {} })
      if (frame.method === 'initialize') {
        outbound.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`)
      } else if (frame.method === 'model/list') {
        outbound.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id,
          result: { data: [{ model: 'm-a' }], nextCursor: null } })}\n`)
      } else if (frame.method === 'thread/start') {
        nextThreadId += 1
        outbound.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id,
          result: { thread: { id: `thread-${nextThreadId}`, ephemeral: false } } })}\n`)
      } else if (frame.method === 'turn/start') {
        nextTurnId += 1
        outbound.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id,
          result: { turn: { id: `turn-${nextTurnId}` } } })}\n`)
      } else {
        outbound.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`)
      }
    }
  })
  let settleExit: (() => void) | undefined
  const done = new Promise<{ exitCode: number; signal: null }>((resolve) => {
    settleExit = () => { resolve({ exitCode: 0, signal: null }) }
  })
  const handle: SubprocessHandle = {
    stdin: inbound,
    stdout: outbound,
    stderr: undefined,
    control: undefined,
    collected: {},
    done,
    terminate(): void { settleExit?.() },
    waitForExit: async () => true,
  }
  return {
    handle,
    send: (message) => { outbound.write(`${JSON.stringify(message)}\n`) },
    requests,
    exit(): void {
      outbound.end()
      inbound.end()
      settleExit?.()
    },
  }
}

/** Track every scripted child in one list for spawn-count assertions. */
function spawnScriptedChild(children: ScriptedChild[]): () => ScriptedChild {
  return () => {
    const child = scriptedChild()
    children.push(child)
    return child
  }
}

function sharedSpec(child: ScriptedChild, overrides: Partial<CodexSharedServerSpec> = {}): CodexSharedServerSpec {
  const catalog: CodexModelCatalog = {
    contents: '{"models":[]}\n', modelIds: ['m-a'], unlistedModelIds: [], contextWindows: { 'm-a': 128000 },
    reasoningByModel: {},
  }
  return {
    home: '/shared-home',
    cwd: '/',
    env: {},
    argv: ['codex', 'app-server', '--stdio'],
    routes: [{ id: 'fallback', nativeName: 'dsh_engine' }],
    expectedModelIds: ['m-a'],
    catalog,
    secrets: [],
    configKey: 'spec',
    disposeGraceMs: 10,
    startupTimeoutMs: 2_000,
    spawn: (_spec: SubprocessSpawnSpec) => child.handle,
    ...overrides,
  }
}

const baseOptions = {
  thread: { model: 'm-a', modelProvider: 'dsh_engine', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  startupTimeoutMs: 2_000,
  onRequest: async () => null,
}

it('multiplexes two conversations over one child without cross-talk', async () => {
  const child = scriptedChild()
  const server = await CodexSharedAppServer.start(sharedSpec(child), new AbortController().signal)
  const receivedA: string[] = []
  const receivedB: string[] = []
  const wireA = await server.attach('/workspace-a', {
    ...baseOptions,
    onRequest: async () => 'answered-a',
  }, new AbortController().signal)
  const wireB = await server.attach('/workspace-b', {
    ...baseOptions,
    onRequest: async (method, params) => {
      receivedB.push(`${method}:${String(params.turnId)}`)
      return 'answered-b'
    },
  }, new AbortController().signal)
  expect(wireA.capturedThreadId()).toBe('thread-1')
  expect(wireB.capturedThreadId()).toBe('thread-2')
  expect(child.requests.filter(request => request.method === 'thread/start')).toHaveLength(2)

  // Turn notifications for thread A never reach thread B's state machine.
  const turnA = wireA.runTurn([{ type: 'text', text: 'hello' }], new AbortController().signal, (chunk) => {
    if (chunk.type === 'text-delta') receivedA.push(chunk.text)
  })
  await new Promise(resolve => setImmediate(resolve))
  expect(child.requests.find(request => request.method === 'turn/start')?.params.threadId).toBe('thread-1')
  child.send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  child.send({ jsonrpc: '2.0', method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'partial ' } })
  child.send({ jsonrpc: '2.0', method: 'item/agentMessage/delta',
    params: { threadId: 'thread-2', turnId: 'turn-x', itemId: 'msg-9', delta: 'FOREIGN' } })
  child.send({ jsonrpc: '2.0', method: 'item/completed',
    params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'partial done' } } })
  child.send({ jsonrpc: '2.0', method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
  await turnA
  expect(receivedA).toEqual(['partial '])
  expect(wireA.collectOutput()).toEqual([{ type: 'text', text: 'partial done' }])
  expect(wireB.collectOutput()).toEqual([])
  expect(receivedB).toEqual([])
  server.detach(wireA)
  server.detach(wireB)
  await server.close()
})

it('routes server requests by thread ownership and answers foreign threads with an error', async () => {
  const child = scriptedChild()
  const server = await CodexSharedAppServer.start(sharedSpec(child), new AbortController().signal)
  const answers: string[] = []
  const wireA = await server.attach('/workspace-a', {
    ...baseOptions,
    onRequest: async () => { answers.push('a'); return {} },
  }, new AbortController().signal)
  const wireB = await server.attach('/workspace-b', {
    ...baseOptions,
    onRequest: async () => { answers.push('b'); return {} },
  }, new AbortController().signal)
  // The request handler only answers inside an active owning turn.
  const turnB = wireB.runTurn([{ type: 'text', text: 'busy-b' }], new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  // The multiplexed transport answers server requests through the router; a
  // request naming thread-2 must reach only conversation B's callback.
  child.send({ jsonrpc: '2.0', id: 'srv-1', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-2', turnId: 'turn-1', availableDecisions: ['accept'] } })
  await new Promise(resolve => setImmediate(resolve))
  expect(answers).toEqual(['b'])
  // A request naming an unattached thread errors back instead of leaking.
  child.send({ jsonrpc: '2.0', id: 'srv-2', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-404', turnId: 'turn-1' } })
  await new Promise(resolve => setImmediate(resolve))
  expect(answers).toEqual(['b'])
  child.send({ jsonrpc: '2.0', method: 'turn/completed',
    params: { threadId: 'thread-2', turn: { id: 'turn-1', status: 'completed' } } })
  await turnB
  server.detach(wireA)
  server.detach(wireB)
  await server.close()
})

it('fails every attachment when the child exits and the host starts a replacement', async () => {
  const children: ScriptedChild[] = []
  const spawnChild = spawnScriptedChild(children)
  let first = spawnChild()
  const host = new CodexSharedServerHost(async () => sharedSpec(first), undefined,
    (spec, signal) => CodexSharedAppServer.start(spec, signal))
  const wire = await (await host.ensureStarted(new AbortController().signal))
    .attach('/workspace', { ...baseOptions }, new AbortController().signal)
  expect(children).toHaveLength(1)
  first.exit()
  await new Promise(resolve => setImmediate(resolve))
  expect(wire.fatalError()?.message).toContain('exited')
  first = spawnChild()
  const replacement = await host.ensureStarted(new AbortController().signal)
  const reattached = await replacement.attach('/workspace', { ...baseOptions }, new AbortController().signal)
  expect(children).toHaveLength(2)
  expect(reattached.capturedThreadId()).toBe('thread-1')
  await host.close()
})

it('refuses a configuration restart while a conversation is inside a native turn', async () => {
  const children: ScriptedChild[] = []
  const spawnChild = spawnScriptedChild(children)
  let first = spawnChild()
  let spec = sharedSpec(first, { configKey: 'v1' })
  const host = new CodexSharedServerHost(async () => spec, undefined,
    (next, signal) => CodexSharedAppServer.start(next, signal))
  const server = await host.ensureStarted(new AbortController().signal)
  const wire = await server.attach('/workspace', {
    ...baseOptions,
    onTurnActive: (active) => { if (active) server.noteTurnActive(); else server.noteTurnSettled() },
  }, new AbortController().signal)
  const turn = wire.runTurn([{ type: 'text', text: 'busy' }], new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  spec = sharedSpec(first, { configKey: 'v2' })
  await expect(host.ensureStarted(new AbortController().signal))
    .rejects.toThrow(/configuration changed while a conversation is inside a native turn/)
  first.send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  first.send({ jsonrpc: '2.0', method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
  await turn
  first = spawnChild()
  spec = sharedSpec(first, { configKey: 'v2' })
  await host.ensureStarted(new AbortController().signal)
  expect(children).toHaveLength(2)
  await host.close()
})
