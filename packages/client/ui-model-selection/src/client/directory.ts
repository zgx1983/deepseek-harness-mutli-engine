/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 * The session's selected execution engine filters the offered model groups,
 * and the composer engine seat reads and selects it through the same store.
 */
import type { TrackProductEvent } from '@deepseek-ai/dsh-client-product-analytics/client'
import type {
  EngineCatalogEntry, ModelCatalogFailure, ModelProviderGroup, ModelSelection, ModelSelectionProjection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { EngineCatalogDirectory } from './engine-catalog.ts'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Engine-selection fold one session's directory exposes to the engine seat. */
export interface ModelDirectoryEngineState {
  /** Registered engines the Host offers, in registration order. */
  engines: readonly EngineCatalogEntry[]
  /** Engine id resolved for this Session; null means the deployment default (native loop). */
  currentId: string | null
  /** Whether the first user message has locked the engine for this Session. */
  fixed: boolean
  /** Lifecycle of the shared engine catalog load. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; null when none. */
  error: string | null
}

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Saved selection, retained even when its provider or model leaves the catalog. */
  current: ModelSelection | null
  /** Saved effort caption retained when the selected model is unavailable. */
  retainedEffort?: string
  /** Whether the current selection is present in the available catalog; null while unresolved. */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Selection submitted by the latest `select` until it settles; null otherwise. */
  pending: ModelSelection | null
  /** Whole-request or selection failure text; null when none. */
  error: string | null
  /** Engine selection exposed to the composer engine seat. */
  engine: ModelDirectoryEngineState
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
    engine: { engines: [], currentId: null, fixed: false, status: 'idle', error: null },
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private unsubscribeCatalog: () => void
  private activeCatalog: ModelCatalogDirectory
  private catalogRequested = false
  private readonly unsubscribeEngines: () => void
  private readonly unsubscribeSelection: () => void
  private readonly unsubscribeEngineSelection: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation model catalog shared by every Session.
   * @param engines - Host-generation engine catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   * @param engineProjected - durable engine selection projected from Session history.
   * @param isBlank - whether this Session has no first message yet.
   * @param track - desktop-only callback after a successful user selection.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel' | 'selectEngine'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly engines: EngineCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
    private readonly engineProjected: ObservableSnapshot<unknown>,
    private readonly isBlank: () => boolean,
    private readonly track?: TrackProductEvent,
  ) {
    this.activeCatalog = catalog
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeEngines = engines.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.unsubscribeEngineSelection = engineProjected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared available model and engine catalogs are loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    this.catalogRequested = true
    this.syncInputs()
    await Promise.all([this.activeCatalog.load(), this.engines.load()])
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /** Reload the engine directory while preserving its displayed choices. */
  refreshEngines(): void {
    this.assertAvailable()
    this.engines.refresh()
  }

  /**
   * Select the complete provider/model/reasoning selection. The durable
   * projection frame updates the shared current; failures surface on the store
   * and return with the operation so each entry can present its own failure.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
   * @returns the selection outcome, including the original Remote failure.
   */
  async select(selection: ModelSelection): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const previous = this.store.getSnapshot().current
    const previousEffort = previous?.reasoningEffort ?? (previous === null ? undefined : this.catalog.reasoningFor(previous)?.defaultEffort)
    const nextEffort = selection.reasoningEffort ?? this.catalog.reasoningFor(selection)?.defaultEffort
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.pending = selection; s.error = null })
    const result = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      return result.ok ? { ok: true, value: undefined } : result
    }
    if (!result.ok) {
      this.store.update((s) => {
        s.status = 'error'
        s.pending = null
        s.error = `${result.error.code}: ${result.error.message}`
      })
      return result
    }
    if (previous !== null) {
      const from = `${previous.provider}/${previous.model}`
      const to = `${selection.provider}/${selection.model}`
      if (from !== to) this.track?.('model_switch', { ...this.isBlank() ? {} : { session_id: this.sessionId }, switch_from: from, switch_to: to })
      if (from === to && previousEffort !== nextEffort) this.track?.('thinking_level_switch', {
        ...this.isBlank() ? {} : { session_id: this.sessionId }, model_name: to, switch_from: previousEffort ?? 'default', switch_to: nextEffort ?? 'default',
      })
    }
    this.store.update((s) => { s.status = 'ready'; s.pending = null; s.error = null })
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Select the Session engine before its first user message locks the choice.
   * @param engineId - registered engine identity.
   * @returns the selection outcome, including the original Remote failure.
   */
  async selectEngine(engineId: string): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const result = await this.sessions.selectEngine({ sessionId: this.sessionId, engineId })
    if (!result.ok) {
      this.store.update((s) => {
        s.engine.error = `${result.error.code}: ${result.error.message}`
      })
      return result
    }
    this.store.update((s) => { s.engine.error = null })
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.pending = null
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeEngineSelection()
    this.unsubscribeSelection()
    this.unsubscribeEngines()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const engineCatalog = this.engines.store.getSnapshot()
    const engine = engineSelection(this.engineProjected.getSnapshot())
    const activeCatalog = this.catalog.forEngine(engine)
    if (activeCatalog !== this.activeCatalog) {
      this.unsubscribeCatalog()
      this.activeCatalog = activeCatalog
      this.unsubscribeCatalog = activeCatalog.store.subscribe(() => { this.syncInputs() })
      if (this.catalogRequested || this.available()) {
        void activeCatalog.load().catch(() => { /* catalog error is displayed in the store */ })
      }
    }
    const catalog = activeCatalog.store.getSnapshot()
    const engineEntry = engine === null
      ? undefined
      : engineCatalog.value?.engines.find(candidate => candidate.id === engine)
    const engineEndpoints = engineEntry?.endpoints ?? []
    const groups = catalog.value === null ? [] : filterCatalogGroups(catalog.value.groups, engineEndpoints)
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const intended = projected?.next ?? catalog.value?.default
    const reasoning = intended === undefined ? undefined : activeCatalog.reasoningFor(intended)
    const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    const engineState: ModelDirectoryEngineState = {
      engines: engineCatalog.value?.engines ?? [],
      currentId: engine,
      fixed: engineLocked(this.engineProjected.getSnapshot()),
      status: engineCatalog.status,
      error: engineCatalog.error,
    }
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      this.store.set({
        current: catalog.value === null ? null : this.store.getSnapshot().current,
        ...retainedEffort === undefined ? {} : { retainedEffort },
        routable: null,
        groups,
        failures: catalog.value?.failures ?? [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        pending: this.store.getSnapshot().pending,
        error: catalog.error,
        engine: engineState,
      })
      return
    }
    const selection = projected.next ?? catalog.value.default
    const routable = groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
    this.store.set({
      current: selection,
      ...retainedEffort === undefined ? {} : { retainedEffort },
      routable,
      groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      pending: this.store.getSnapshot().pending,
      error: null,
      engine: engineState,
    })
  }
}

/**
 * Keep only providers and models the active engine's endpoints support. An
 * engine that filters by endpoints sees only advertising providers/models; an
 * engine that does not filter (the native loop) sees everything.
 * @param groups - full provider groups from the shared catalog.
 * @param engineEndpoints - endpoint ids the active engine routes to.
 * @returns groups with non-serving providers and models removed.
 */
function filterCatalogGroups(
  groups: readonly ModelProviderGroup[],
  engineEndpoints: readonly string[],
): readonly ModelProviderGroup[] {
  if (engineEndpoints.length === 0) return groups
  const serving = (endpoints: readonly string[] | undefined): boolean =>
    endpoints !== undefined && endpoints.some(id => engineEndpoints.includes(id))
  return groups.flatMap((group) => {
    if (!serving(group.endpoints)) return []
    const models = group.models.filter(model => serving(model.endpoints ?? group.endpoints))
    return models.length === 0 ? [] : [{ ...group, models }]
  })
}

function engineSelection(value: unknown): string | null {
  if (value === undefined) return null
  const engineId = (value as { engineId?: unknown }).engineId
  return typeof engineId === 'string' && engineId.length > 0 ? engineId : null
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}

/** Read the user-message lock from the Host projection. */
function engineLocked(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'locked' in value && value.locked === true
}
