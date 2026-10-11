import type { EngineCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import { EngineCatalogDirectory } from '../src/client/engine-catalog.ts'

const catalog = (engine: string): EngineCatalog => ({
  engines: [{ id: engine, name: engine, endpoints: engine === 'native' ? [] : ['openai-compatible'] }],
})

function directory(engines: () => Promise<unknown>): EngineCatalogDirectory {
  // The providing plugin's context, scripted down to the one method it calls.
  return new EngineCatalogDirectory({ remote: { session: { engineCatalog: engines } } } as never)
}

describe('EngineCatalogDirectory', () => {
  it('shares one failing request, exposes the RPC error, and permits a retry', async () => {
    const engines = vi.fn()
      .mockResolvedValueOnce({
        ok: false, error: new RemoteError('gateway/internal', 'catalog offline', {}),
      })
      .mockResolvedValueOnce({ ok: true, value: catalog('codex') })
    const subject = directory(engines)

    const first = subject.load()
    expect(subject.load()).toBe(first)
    await expect(first).rejects.toThrow('gateway/internal: catalog offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: catalog offline' })
    await expect(subject.load()).resolves.toEqual(catalog('codex'))
    expect(engines).toHaveBeenCalledTimes(2)
  })

  it('does not publish a successful result from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const engines = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(engines)

    const stale = subject.load()
    subject.resetGeneration()
    first.resolve({ ok: true, value: catalog('stale') })
    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading' })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('contains refresh failures while retaining old data and clears them on a failed Host reset', async () => {
    const engines = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('native') })
      .mockRejectedValueOnce('refresh failed')
      .mockRejectedValueOnce(new Error('reset failed'))
    const subject = directory(engines)
    await subject.load()

    subject.refresh()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'refresh failed' })
    })
    expect(subject.store.getSnapshot().value).toEqual(catalog('native'))

    subject.resetGeneration()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'reset failed', value: null })
    })
  })
})
