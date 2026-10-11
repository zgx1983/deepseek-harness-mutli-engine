// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { SessionCreateRow } from '../src/client/SessionCreateRow.tsx'

const activeContexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
})

interface PresentationCapture {
  readonly slots: SlotRegistry
}

function providePresentation(ctx: Context): PresentationCapture {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: string) => key,
  })
  return { slots }
}

async function mount(ids: readonly string[]): Promise<{ ctx: Context; slots: SlotRegistry; openSession: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  activeContexts.push(ctx)
  ctx.provide('sessions', { list: { getSnapshot: () => ({ ids }) } })
  const openSession = vi.fn()
  ctx.provide('uiWorkspace', { openSession })
  const slots = providePresentation(ctx).slots
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots, openSession }
}

describe('ui-session-manage apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'uiWorkspace', 'sessions'])
  })

  it('registers the dedicated session_create row', async () => {
    const { slots } = await mount([])
    const entry = slots.entries('tool.call.toolview')[0]
    expect(entry?.options).toMatchObject({ key: 'session_create', priority: -10 })
    expect(entry?.locale).toBe('session-manage')
    expect(entry?.component).toBe(SessionCreateRow)
  })

  it('opens sessions the Host list still carries', async () => {
    const { slots, openSession } = await mount(['session-1', 'session-2'])
    const entry = slots.entries('tool.call.toolview')[0]
    const injected = entry?.inject?.() as { openSession: (id: string) => void }
    injected.openSession('session-2')
    expect(openSession).toHaveBeenCalledWith('session-2')
  })

  it('drops navigation for a session absent from the Host list', async () => {
    const { slots, openSession } = await mount(['session-1'])
    const entry = slots.entries('tool.call.toolview')[0]
    const injected = entry?.inject?.() as { openSession: (id: string) => void }
    injected.openSession('session-gone')
    expect(openSession).not.toHaveBeenCalled()
  })

  it('frees the toolview key on fiber disposal (HMR safety)', async () => {
    const { ctx, slots } = await mount([])
    expect(slots.entries('tool.call.toolview')).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
  })
})
