/**
 * Shared KV-backend conformance suite. Each backend's spec file calls
 * {@link runKvBackendContract} with a factory bound to its own medium; the
 * suite asserts every clause of the `src/backend.ts` contract so both
 * backends are held to identical semantics.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { KvUnitDescriptor, StorageBackend } from '../src/backend.ts'

/** One conformance run: a fresh backend plus a way to reopen the same medium (crash simulation). */
export interface KvBackendContractHarness {
  /** The backend under test, freshly created over an empty medium. */
  backend: StorageBackend
  /** Open a NEW backend instance over the SAME medium, as after a process restart. */
  reopen(): Promise<StorageBackend>
}

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'contract_unit',
  version: 3,
  tables: ['alpha', 'beta'],
  hasGlobal: true,
}

/**
 * Run the shared conformance suite against one backend implementation.
 * @param label - Suite label, e.g. `json` / `sqlite`.
 * @param create - Factory producing a fresh harness per test.
 */
export function runKvBackendContract(label: string, create: () => Promise<KvBackendContractHarness>) {
  describe(`kv backend contract: ${label}`, () => {
    it('opens a missing unit as empty and serves loadAll immediately', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      const snapshot = await unit.loadAll()
      expect(snapshot.tables).toEqual({ alpha: {}, beta: {} })
      expect(snapshot.global).toBeNull()
      await backend.close()
    })

    it('round-trips records and global durably across reopen', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k1', { n: 1 })
      await unit.putRecord('alpha', 'k2', { n: 2 })
      await unit.putRecord('beta', 'weird key / with:stuff', { ok: true })
      await unit.setGlobal({ counter: 7 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      const snapshot = await unit2.loadAll()
      expect(snapshot.tables['alpha']).toEqual({ k1: { n: 1 }, k2: { n: 2 } })
      expect(snapshot.tables['beta']).toEqual({ 'weird key / with:stuff': { ok: true } })
      expect(snapshot.global).toEqual({ counter: 7 })
      await reopened.close()
    })

    it('putRecord overwrites and deleteRecord is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 'old' })
      await unit.putRecord('alpha', 'k', { v: 'new' })
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'never-existed')
      const snapshot = await unit.loadAll()
      expect(snapshot.tables['alpha']).toEqual({})
      await backend.close()
    })

    it('rejects a version mismatch on reopen without touching the data', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 1 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      await expect(reopened.kv!.open({ ...DESCRIPTOR, version: 4 })).rejects.toMatchObject({
        name: 'StorageError',
        code: 'version-mismatch',
      })
      // Original version still opens and still holds the data.
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      expect((await unit2.loadAll()).tables['alpha']).toEqual({ k: { v: 1 } })
      await reopened.close()
    })

    it('rejects operations after unit close, and close is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.close()
      await unit.close()
      await expect(unit.putRecord('alpha', 'k', {})).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
      await backend.close()
      await backend.close()
    })

    it('applies a batch atomically and durably, in order, across reopen', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.applyBatch!([
        { kind: 'put', table: 'alpha', key: 'k1', value: { n: 1 } },
        { kind: 'put', table: 'alpha', key: 'k1', value: { n: 2 } },
        { kind: 'put', table: 'beta', key: 'k2', value: { ok: true } },
        { kind: 'delete', table: 'beta', key: 'gone' },
        { kind: 'global', value: { counter: 3 } },
      ])
      await harness.backend.close()
      const reopened = await harness.reopen()
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      const snapshot = await unit2.loadAll()
      expect(snapshot.tables['alpha']).toEqual({ k1: { n: 2 } })
      expect(snapshot.tables['beta']).toEqual({ k2: { ok: true } })
      expect(snapshot.global).toEqual({ counter: 3 })
      await reopened.close()
    })

    it('resolves an empty batch without touching the medium', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.applyBatch!([])
      expect(await unit.loadAll()).toEqual({ tables: { alpha: {}, beta: {} }, global: null })
      await backend.close()
    })

    it('rejects a batch with an undeclared table and applies nothing', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'kept', { v: 1 })
      await expect(unit.applyBatch!([
        { kind: 'put', table: 'alpha', key: 'k', value: { v: 2 } },
        { kind: 'put', table: 'gamma', key: 'k', value: { v: 3 } },
      ])).rejects.toThrow(/gamma/)
      expect((await unit.loadAll()).tables['alpha']).toEqual({ kept: { v: 1 } })
      await backend.close()
    })

    it('rolls the whole batch back when a member fails mid-way', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'kept', { v: 1 })
      await unit.setGlobal({ counter: 1 })
      // An unserializable value fails the batch at its own slot; earlier
      // members of the same batch — records and the global — must not survive.
      const unserializable = { toJSON() { throw new Error('no serialization') } }
      await expect(unit.applyBatch!([
        { kind: 'put', table: 'alpha', key: 'first', value: { v: 2 } },
        { kind: 'put', table: 'alpha', key: 'kept', value: { v: 9 } },
        { kind: 'global', value: { counter: 2 } },
        { kind: 'put', table: 'beta', key: 'second', value: unserializable },
      ])).rejects.toThrow()
      const snapshot = await unit.loadAll()
      expect(snapshot.tables['alpha']).toEqual({ kept: { v: 1 } })
      expect(snapshot.tables['beta']).toEqual({})
      expect(snapshot.global).toEqual({ counter: 1 })
      await harness.backend.close()
    })

    it('rejects a global batch operation on a unit without a global slot', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open({ ...DESCRIPTOR, hasGlobal: false })
      await expect(unit.applyBatch!([{ kind: 'global', value: { n: 1 } }])).rejects.toThrow(/global/)
      await unit.applyBatch!([{ kind: 'put', table: 'alpha', key: 'k', value: { ok: true } }])
      expect((await unit.loadAll()).tables['alpha']).toEqual({ k: { ok: true } })
      await backend.close()
    })

    it('rejects batch operations after unit close', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.close()
      await expect(unit.applyBatch!([{ kind: 'put', table: 'alpha', key: 'k', value: {} }]))
        .rejects.toMatchObject({ code: 'closed' })
      await backend.close()
    })
  })
}
