/** Shared external execution identities and cancellation-aware waits. */
import type { Agent } from './types.ts'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Native session identity crossing the provider process boundary. */
export type NativeEngineSessionId = Branded<'NativeEngineSessionId'>

/** Native failure whose terminal delivery was acknowledged by the execution engine. */
export class EngineTurnSettledError extends Error {
  /**
   * @param message - terminal native failure or interruption description.
   */
  constructor(message: string) { super(message); this.name = 'EngineTurnSettledError' }
}

/**
 * Remove a resolved engine credential from an upstream failure before public logging.
 * @param error - SDK or protocol failure.
 * @param credential - private credential supplied to this child.
 * @returns a safe diagnostic preserving authoritative native settlement.
 */
export function engineFailure(error: unknown, credential: string | undefined): Error {
  const message = error instanceof Error ? error.message : String(error)
  const safe = credential === undefined || credential.length === 0 ? message : message.split(credential).join('[redacted]')
  return error instanceof EngineTurnSettledError ? new EngineTurnSettledError(safe) : new Error(safe)
}

/**
 * Read a validated provider binding from durable observational records.
 * @param agent - persistence-owned Agent.
 * @param engineId - provider whose identity is requested.
 * @returns the last native identity for this engine, when bound.
 */
export function nativeBindingFor(agent: Agent, engineId: string): NativeEngineSessionId | undefined {
  let result: NativeEngineSessionId | undefined
  // oxlint-disable-next-line typescript/no-deprecated -- Ordered external binding replay.
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'engine/item-settled' || event.data.category !== 'binding') continue
    const value = event.data.payload
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid engine binding record')
    if (!('engineId' in value) || value.engineId !== engineId) continue
    if (!('nativeSessionId' in value) || typeof value.nativeSessionId !== 'string' || value.nativeSessionId.length === 0) {
      throw new Error('Invalid native session identity')
    }
    if ('cwd' in value && value.cwd !== agent.session.header.cwd) throw new Error('Native engine workspace differs from the persisted binding')
    result = brandString<NativeEngineSessionId>(value.nativeSessionId)
  }
  return result
}

/**
 * Persist an acknowledged binding without recording credentials or process handles.
 * @param agent - owning Agent.
 * @param engineId - execution provider.
 * @param nativeSessionId - identity acknowledged by the provider.
 */
export function recordNativeBinding(agent: Agent, engineId: string, nativeSessionId: string): void {
  if (nativeBindingFor(agent, engineId) === nativeSessionId) return
  agent.session.append('engine/item-settled', {
    nativeItemId: nativeSessionId, revision: 1, category: 'binding',
    payload: { engineId, nativeSessionId, ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd } },
  })
}

/**
 * Read the durable plan-mode state of one engine.
 * @param agent - persistence-owned Agent.
 * @param engineId - provider whose plan-mode state is requested.
 * @returns the last recorded plan-mode state, or undefined before any switch.
 */
export function enginePlanModeFor(agent: Agent, engineId: string): boolean | undefined {
  let result: boolean | undefined
  // oxlint-disable-next-line typescript/no-deprecated -- Ordered external mode replay.
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'engine/item-settled' || event.data.category !== 'mode') continue
    const value = event.data.payload
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid engine mode record')
    if (!('engineId' in value) || value.engineId !== engineId) continue
    if (!('plan' in value) || typeof value.plan !== 'boolean') throw new Error('Invalid engine plan-mode record')
    result = value.plan
  }
  return result
}

/**
 * Persist an engine-acknowledged plan-mode switch so restarts restore it.
 * @param agent - owning Agent.
 * @param engineId - execution provider whose mode switched.
 * @param plan - whether the engine now runs its plan mode.
 */
export function recordEnginePlanMode(agent: Agent, engineId: string, plan: boolean): void {
  if (enginePlanModeFor(agent, engineId) === plan) return
  agent.session.append('engine/item-settled', {
    nativeItemId: `${engineId}:plan-mode`, revision: 1, category: 'mode',
    payload: { engineId, plan },
  })
}

/**
 * Replay the durable delivery ledger: submitted inputs with no terminal settlement.
 * @param agent - Session whose dispatch ledger is inspected.
 * @returns the input ids lacking an `engine/turn-settled` record.
 */
function pendingEngineInputs(agent: Agent): Set<string> {
  const pending = new Set<string>()
  // oxlint-disable-next-line typescript/no-deprecated -- Durable delivery ledger replay.
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'engine/input-submitted') pending.add(event.data.inputId)
    if (event.type === 'engine/turn-settled') pending.delete(event.data.turnId)
  }
  return pending
}

/**
 * Acknowledge unresolved native delivery as uncertain without resubmitting the inputs.
 *
 * An external engine owns its delivery record: the native session history is
 * the authority for whether a dispatched turn ran, and the next prompt resumes
 * that history rather than replaying the input. A durable input with no
 * terminal settlement — a writer that crashed mid-turn, a dead transport, an
 * unacknowledged interrupt — therefore settles here as `acknowledged-uncertain`
 * instead of blocking the session.
 * @param agent - owning Agent; turn preparation may already be running.
 * @returns number of delivery intents acknowledged as uncertain.
 */
export function acknowledgeUncertainEngineInputs(agent: Agent): number {
  const pending = pendingEngineInputs(agent)
  for (const turnId of pending) agent.session.append('engine/turn-settled', { turnId, outcome: 'acknowledged-uncertain' })
  return pending.size
}

/**
 * Await an operation while observing cancellation without leaving an unhandled rejection.
 * @param pending - provider operation.
 * @param signal - owner cancellation or deadline.
 * @returns the operation result before cancellation.
 */
export async function engineWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([pending, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Retain one bounded native activity and publish monotone item revisions.
 * @param agent - owning Agent whose log stores the observations.
 * @param maxCharacters - configured maximum argument and output text retained per activity.
 * @returns an updater shared by native start, progress and completion callbacks.
 */
export function engineActivityRecorder(agent: Agent, maxCharacters: number): {
  (id: string, patch: Partial<import('./types.ts').EngineActivityRecord>): void
  finish(): void
} {
  const activities = new Map<string, { revision: number; value: import('./types.ts').EngineActivityRecord }>()
  const revisions = new Map<string, number>()
  const update = (id: string, patch: Partial<import('./types.ts').EngineActivityRecord>): void => {
    const previous = activities.get(id)
    const value: import('./types.ts').EngineActivityRecord = {
      name: patch.name ?? previous?.value.name ?? id,
      argsRaw: (patch.argsRaw ?? previous?.value.argsRaw ?? '').slice(0, maxCharacters),
      output: (patch.output ?? previous?.value.output ?? '').slice(0, maxCharacters),
      status: patch.status ?? previous?.value.status ?? 'running',
    }
    const revision = (revisions.get(id) ?? 0) + 1
    revisions.set(id, revision)
    activities.set(id, { revision, value })
    agent.session.append('engine/item-settled', { nativeItemId: id, revision, category: 'activity', payload: value })
    if (value.status !== 'running') activities.delete(id)
  }
  update.finish = (): void => {
    for (const id of activities.keys()) update(id, { status: 'failed' })
  }
  return update
}

/**
 * Persist engine children independently from foreground tool-call settlement.
 * @param agent - owning parent whose log retains observations.
 * @param engine - native provider identity.
 * @param maxCharacters - maximum retained text per child field.
 * @returns revisioned updater and process-disconnection marker.
 */
export function engineSubagentRecorder(agent: Agent, engine: 'claude' | 'codex', maxCharacters: number): {
  update(id: string, patch: import('./types.ts').EngineSubagentPatch): void
  disconnect(): void
} {
  type Record = import('./types.ts').EngineSubagentRecord
  const records = new Map<string, { revision: number; value: Record }>()
  const revisions = new Map<string, number>()
  // oxlint-disable-next-line typescript/no-deprecated -- Continue native item revisions across process replacement.
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'engine/item-settled') continue
    if (event.data.category === 'subagent-disconnected') {
      const marker = event.data.payload
      if (marker !== null && typeof marker === 'object' && 'engine' in marker && marker.engine === engine) {
        for (const record of records.values()) {
          if (record.value.status === 'running' || record.value.status === 'pending') record.value = { ...record.value, status: 'unknown' }
        }
      }
    }
    if (event.data.category !== 'subagent') continue
    revisions.set(event.data.nativeItemId, event.data.revision)
    const value = event.data.payload
    if (value === null || typeof value !== 'object' || !('engine' in value) || value.engine !== engine) continue
    if (!('id' in value) || typeof value.id !== 'string' || value.id.length === 0
      || !('title' in value) || typeof value.title !== 'string'
      || !('progress' in value) || typeof value.progress !== 'string'
      || !('output' in value) || typeof value.output !== 'string'
      || !('status' in value) || (value.status !== 'pending' && value.status !== 'running'
        && value.status !== 'completed' && value.status !== 'failed' && value.status !== 'stopped' && value.status !== 'unknown')) {
      throw new Error('Invalid persisted engine child observation')
    }
    const timestamp = (time: unknown): number | undefined => {
      if (time === undefined) return undefined
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw new Error('Invalid persisted engine child timestamp')
      return time
    }
    if ('model' in value && value.model !== undefined && typeof value.model !== 'string') throw new Error('Invalid persisted engine child model')
    if ('parentId' in value && value.parentId !== undefined && typeof value.parentId !== 'string') throw new Error('Invalid persisted engine child parent')
    records.set(value.id, { revision: event.data.revision, value: {
      engine, id: brandString<import('./types.ts').EngineSubagentId>(value.id), title: value.title,
      progress: value.progress, output: value.output, status: value.status,
      startedAt: timestamp('startedAt' in value ? value.startedAt : undefined),
      endedAt: timestamp('endedAt' in value ? value.endedAt : undefined),
      ...'model' in value && typeof value.model === 'string' ? { model: value.model } : {},
      ...'parentId' in value && typeof value.parentId === 'string'
        ? { parentId: brandString<import('./types.ts').EngineSubagentId>(value.parentId) } : {},
    } })
  }
  const update = (id: string, patch: import('./types.ts').EngineSubagentPatch): void => {
    const previous = records.get(id)
    const status = patch.status ?? previous?.value.status ?? 'running'
    const terminal = status === 'completed' || status === 'failed' || status === 'stopped'
    const restarting = status === 'running' && previous !== undefined
      && ['completed', 'failed', 'stopped'].includes(previous.value.status)
    const previousValue = previous?.value
    const { endedAt: previousEnd, ...withoutEnd } = previousValue ?? {}
    const { parentId, ...patchFields } = patch
    const value: Record = {
      ...withoutEnd,
      ...!restarting && previousEnd !== undefined ? { endedAt: previousEnd } : {},
      ...patchFields, engine, id: brandString<import('./types.ts').EngineSubagentId>(id),
      ...parentId === undefined ? {} : { parentId: brandString<import('./types.ts').EngineSubagentId>(parentId) },
      title: (patch.title ?? previous?.value.title ?? id).slice(0, maxCharacters),
      progress: (patch.progress ?? previous?.value.progress ?? '').slice(0, maxCharacters),
      output: (patch.output ?? previous?.value.output ?? '').slice(0, maxCharacters),
      status,
      ...status === 'running' && previous?.value.startedAt === undefined ? { startedAt: Date.now() } : {},
      ...terminal ? { endedAt: patch.endedAt ?? previousEnd ?? Date.now() } : {},
    }
    const nativeItemId = `${engine}:subagent:${id}`
    const revision = (revisions.get(nativeItemId) ?? 0) + 1
    revisions.set(nativeItemId, revision)
    records.set(id, { revision, value })
    agent.session.append('engine/item-settled', {
      nativeItemId: `${engine}:subagent:${id}`, revision, category: 'subagent', payload: value,
    })
  }
  return {
    update,
    disconnect() {
      // The marker also invalidates running records recovered from an earlier process.
      agent.session.append('engine/item-settled', {
        nativeItemId: `${engine}:subagent:connection`, revision: 1,
        category: 'subagent-disconnected', payload: { engine },
      })
      for (const [id, record] of records) {
        if (record.value.status === 'running' || record.value.status === 'pending') update(id, { status: 'unknown' })
      }
    },
  }
}
