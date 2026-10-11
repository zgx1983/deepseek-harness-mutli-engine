/**
 * One opened JSON unit in `single` layout: the whole unit is one document at
 * `<root>/<name>.json`. The in-memory state is authoritative; every write
 * primitive mutates it and republishes the whole file atomically. Writes are
 * NOT queued here — per the backend contract, write ordering belongs to the
 * caller (the domain layer's write chain); this unit only guarantees that
 * each single call publishes a complete, durable file. The `per-record`
 * layout is a separate unit class in `per-record-unit.ts`.
 * @module @deepseek-ai/dsh-storage-json/src/single-unit
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvBatchOperation, KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'

/**
 * Open (load or lazily create) one `single`-layout unit under `root`: the
 * unit file is `<root>/<name>.json`.
 * @param descriptor - Static identity and shape of the unit.
 * @param root - Absolute backend root directory.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */
export async function openSingleUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  const path = join(root, `${descriptor.name}.json`)
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Missing file = empty unit; materialization defers to the first write.
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new SingleJsonUnit(descriptor, path, state, onClose)
}

/**
 * One undo entry covering either a record write or the global write; the
 * previous value restores the exact pre-batch state even when several
 * operations touch the same key.
 */
type BatchUndo =
  | { kind: 'global'; previous: unknown }
  | { kind: 'record'; table: string; key: string; hadKey: boolean; previous: unknown }

class SingleJsonUnit implements KvUnit {
  private closed = false
  /** In-flight publishes; close() drains them before releasing the unit. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
  ) {}

  // oxlint-disable-next-line typescript/require-await -- async keeps the closed guard a rejection, not a synchronous throw
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    const hadKey = records.has(key)
    const previous = records.get(key)
    records.set(key, value)
    // Roll back on a failed publish: memory is authoritative, so a rejected
    // write must not survive in memory (or ride along with the next publish).
    await this.publish().catch((error: unknown) => {
      if (hadKey) records.set(key, previous)
      else records.delete(key)
      throw error
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const previous = records.get(key)
    records.delete(key)
    await this.publish().catch((error: unknown) => {
      records.set(key, previous)
      throw error
    })
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const previous = this.state.global
    this.state.global = value
    await this.publish().catch((error: unknown) => {
      this.state.global = previous
      throw error
    })
  }

  async applyBatch(operations: readonly KvBatchOperation[]): Promise<void> {
    this.assertOpen()
    if (operations.length === 0) return
    // Validate the whole batch before touching memory, so an undeclared
    // table or an unexpected global write rejects without a rollback pass.
    for (const operation of operations) {
      if (operation.kind === 'global') {
        if (!this.descriptor.hasGlobal) {
          throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
        }
        continue
      }
      this.records(operation.table)
    }
    const undo: BatchUndo[] = []
    for (const operation of operations) {
      if (operation.kind === 'global') {
        undo.push({ kind: 'global', previous: this.state.global })
        this.state.global = operation.value
        continue
      }
      const records = this.records(operation.table)
      undo.push({
        kind: 'record', table: operation.table, key: operation.key,
        hadKey: records.has(operation.key), previous: records.get(operation.key),
      })
      if (operation.kind === 'put') records.set(operation.key, operation.value)
      else records.delete(operation.key)
    }
    // One publish carries the whole net state, so the batch is as atomic and
    // durable as any single write. Roll back memory on a failed publish: the
    // next publish must not ride out partial batch state.
    await this.publish().catch((error: unknown) => {
      for (const entry of undo.reverse()) {
        if (entry.kind === 'global') this.state.global = entry.previous
        else {
          const records = this.records(entry.table)
          if (entry.hadKey) records.set(entry.key, entry.previous)
          else records.delete(entry.key)
        }
      }
      throw error
    })
  }

  /* jscpd:ignore-start -- the two unit classes are standalone; the drain/guard lifecycle mirrors the shared KvUnit contract */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }
  /* jscpd:ignore-end */

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  private publish(): Promise<void> {
    // Deferred one microtask so a synchronous serialize failure (an
    // unserializable record) becomes a rejected promise — every caller's
    // rollback `.catch` must observe it instead of losing the rollback.
    const write = Promise.resolve().then(() => writeAtomic(this.path, serialize(this.descriptor.name, this.state)))
    this.inFlight.add(write)
    // Swallow only on the tracking branch: the caller still awaits `write`
    // itself, so rejections stay observed exactly once.
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}
