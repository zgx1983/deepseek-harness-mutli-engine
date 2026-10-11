import type {
  EngineCatalog, ModelCatalog, ModelSelection, ModelSelectionProjection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { EngineCatalogDirectory } from '../src/client/engine-catalog.ts'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

const sessionId = SessionId('session-engine-spec')

const modelCatalog = (): ModelCatalog => ({
  default: { provider: 'fixture', model: 'fixture-model' },
  routableProviders: ['fixture'],
  groups: [
    {
      id: 'fixture',
      name: 'Fixture',
      endpoints: ['fixture-api'],
      models: [
        { id: 'fixture-model', name: 'Fixture Model' },
        { id: 'excluded-model', name: 'Excluded Model', endpoints: ['other-api'] },
      ],
    },
    {
      id: 'other',
      name: 'Other',
      endpoints: ['other-api'],
      models: [{ id: 'other-model', name: 'Other Model' }],
    },
  ],
  failures: [],
})

const engineCatalog = (): EngineCatalog => ({
  engines: [
    { id: 'native', name: 'Native', endpoints: [] },
    { id: 'codex', name: 'Codex', endpoints: ['fixture-api'] },
  ],
})

interface DirectoryHarness {
  readonly directory: ModelDirectory
  readonly catalog: ModelCatalogDirectory
  readonly engines: EngineCatalogDirectory
  readonly projected: ObservableSnapshot<unknown>
  readonly engineProjected: ObservableSnapshot<unknown>
  readonly selectModel: ReturnType<typeof vi.fn>
  readonly selectEngine: ReturnType<typeof vi.fn>
}

function harness(
  engineId: string | null,
  selection: ModelSelection | null = { provider: 'fixture', model: 'fixture-model' },
): DirectoryHarness {
  const projected = createSnapshotStore<unknown>(
    selection === null ? null : ({ next: selection, lastUsed: null } satisfies ModelSelectionProjection),
  )
  const engineProjected = createSnapshotStore<unknown>({ engineId, locked: engineId !== null })
  const catalog = new ModelCatalogDirectory({
    remote: { session: { modelCatalog: vi.fn().mockResolvedValue({ ok: true, value: modelCatalog() }) } },
  } as never)
  const engines = new EngineCatalogDirectory({
    remote: { session: { engineCatalog: vi.fn().mockResolvedValue({ ok: true, value: engineCatalog() }) } },
  } as never)
  const selectModel = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const selectEngine = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const directory = new ModelDirectory(
    { selectModel, selectEngine } as never,
    sessionId,
    () => true,
    catalog,
    engines,
    projected,
    engineProjected,
    () => true,
  )
  return { directory, catalog, engines, projected, engineProjected, selectModel, selectEngine }
}

describe('ModelDirectory engine filtering', () => {
  it('offers every group and model while the session runs the native default', async () => {
    const { directory } = harness(null)
    await directory.load()
    const state = directory.store.getSnapshot()
    expect(state.groups).toHaveLength(2)
    expect(state.groups[0]!.models.map(model => model.id)).toEqual(['fixture-model', 'excluded-model'])
    expect(state.engine).toMatchObject({ currentId: null, fixed: false, engines: [
      { id: 'native', endpoints: [] },
      { id: 'codex', endpoints: ['fixture-api'] },
    ] })
  })

  it('keeps only providers and models whose endpoints serve the resolved engine', async () => {
    const { directory } = harness('codex')
    await directory.load()
    const state = directory.store.getSnapshot()
    expect(state.groups).toHaveLength(1)
    expect(state.groups[0]!.id).toBe('fixture')
    expect(state.groups[0]!.models.map(model => model.id)).toEqual(['fixture-model'])
    expect(state.engine).toMatchObject({ currentId: 'codex', fixed: true })
  })

  it('marks the engine fixed once the Session resolved one, and submits selection through selectEngine', async () => {
    const { directory, selectEngine } = harness(null)
    await directory.load()
    expect(directory.store.getSnapshot().engine.fixed).toBe(false)

    const result = await directory.selectEngine('codex')
    expect(result.ok).toBe(true)
    expect(selectEngine).toHaveBeenCalledWith({ sessionId, engineId: 'codex' })
  })

  it('surfaces a rejected engine selection on the engine error strip', async () => {
    const { directory, selectEngine } = harness(null)
    selectEngine.mockResolvedValue({
      ok: false,
      error: new RemoteError('session/engine-locked', 'session already dispatched work', { sessionId }),
    })
    await directory.load()

    const result = await directory.selectEngine('codex')
    expect(result.ok).toBe(false)
    expect(directory.store.getSnapshot().engine.error).toContain('session/engine-locked')
  })

  it('does not mark the engine fixed for a session that resolved none', async () => {
    const { directory } = harness(null)
    await directory.load()
    expect(directory.store.getSnapshot().engine).toMatchObject({ currentId: null, fixed: false })
  })
})
