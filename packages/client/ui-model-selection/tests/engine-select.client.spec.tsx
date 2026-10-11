// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { EngineSelect } from '../src/client/EngineSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof EngineSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: null,
    routable: null,
    groups: [],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
    engine: {
      engines: [
        { id: 'native', name: 'Native', endpoints: [] },
        { id: 'codex', name: 'Codex', description: 'Runs GPT models', endpoints: ['openai-compatible'] },
      ],
      currentId: null,
      fixed: false,
      status: 'ready',
      error: null,
    },
    ...overrides,
  }
}

afterEach(cleanup)

describe('EngineSelect', () => {
  it('shows the native default and offers the engine menu', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (engineId: string) => {
      directory.set(state({
        engine: {
          engines: directory.getSnapshot().engine.engines,
          currentId: engineId,
          fixed: true,
          status: 'ready',
          error: null,
        },
      }))
      return { ok: true as const, value: undefined }
    })
    render(<EngineSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择执行引擎，当前 原生' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '选择执行引擎，当前 原生' }))
    await waitFor(() => {
      expect(screen.getByRole('menuitemradio', { name: /Codex/ })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Codex/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith('codex')
    })
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '选择执行引擎，当前 Codex' })).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each([{ locked: false, fixed: true }, { locked: true, fixed: true }, { locked: true, fixed: false }])('shows only the current engine when the Session is fixed ($locked/$fixed)', ({ locked, fixed }) => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      engine: {
        engines: state().engine.engines,
        currentId: 'codex',
        fixed,
        status: 'ready',
        error: null,
      },
    }))
    render(<EngineSelect
      locked={locked}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn()}
      t={t}
    />)

    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByText('Native')).toBeNull()
  })

  it('surfaces the shared engine load failure with a retry', async () => {
    const load = vi.fn()
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      engine: {
        engines: [],
        currentId: null,
        fixed: false,
        status: 'error',
        error: 'gateway/internal: engines offline',
      },
    }))
    render(<EngineSelect
      locked={false}
      available
      directory={directory}
      load={load}
      select={vi.fn()}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: '选择执行引擎，当前 原生' }))
    await waitFor(() => {
      expect(screen.getByText(/engines offline/)).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(load).toHaveBeenCalled()
  })
})
