// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionCreateRow, narrowSessionCreatedMeta } from '../src/client/SessionCreateRow.tsx'
import { zh } from '../src/client/locales.ts'

type SessionCreateRowProps = Parameters<typeof SessionCreateRow>[0]

const t: SessionCreateRowProps['t'] = makeTranslate(zh, commonZh)
const openSession = vi.fn()

afterEach(cleanup)

function settled(over: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-session-create',
    call: { name: 'session_create', argsRaw: '{"cwd":"/work/alpha","engine_id":"native"}' },
    callTime: 2_000,
    content: [{ type: 'text', text: '{"sessionId":"session-1","engineId":"native","reused":false}' }],
    isError: false,
    subCalls: [],
    ...over,
  }
}

function running(argsRaw = '{"cwd":"/work/alpha"}', over: Partial<StartedToolCall> = {}): StartedToolCall {
  return {
    phase: 'start' as const, callId: 'call-session-create', name: 'session_create', argsRaw, turn: 1, step: 1, time: 2_000, subCalls: [],
    ...over,
  }
}

function props(block: SessionCreateRowProps['block']): SessionCreateRowProps {
  const owner: ToolCallOwnerProps = {
    callId: block.callId,
    toolName: 'session_create',
    ...('kind' in block ? { phase: 'result' as const, block }
      : block.phase === 'preparing' ? { phase: 'preparing' as const, block } : { phase: 'start' as const, block }),
    useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }),
    loadImage: vi.fn<ToolCallOwnerProps['loadImage']>(),
    openFile: vi.fn(),
  }
  return { ...owner, t, openSession } as SessionCreateRowProps
}

describe('narrowSessionCreatedMeta', () => {
  it('accepts the complete persisted meta', () => {
    expect(narrowSessionCreatedMeta({
      sessionId: 'session-1',
      engineId: 'native',
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      title: 'GLM work session',
      reused: false,
    })).toEqual({
      sessionId: 'session-1',
      engineId: 'native',
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      title: 'GLM work session',
      reused: false,
    })
  })

  it('rejects non-object meta and malformed fields', () => {
    expect(narrowSessionCreatedMeta(null)).toBeUndefined()
    expect(narrowSessionCreatedMeta('session-1')).toBeUndefined()
    expect(narrowSessionCreatedMeta({})).toBeUndefined()
    expect(narrowSessionCreatedMeta({ sessionId: '', reused: false })).toBeUndefined()
    expect(narrowSessionCreatedMeta({ sessionId: 'session-1', reused: 'no' })).toBeUndefined()
    expect(narrowSessionCreatedMeta({ sessionId: 'session-1', reused: false, engineId: 1 })).toBeUndefined()
    expect(narrowSessionCreatedMeta({ sessionId: 'session-1', reused: false, title: 1 })).toBeUndefined()
    expect(narrowSessionCreatedMeta({ sessionId: 'session-1', reused: false, model: 'glm' })).toBeUndefined()
    expect(narrowSessionCreatedMeta({ sessionId: 'session-1', reused: false, model: { provider: 'p' } })).toBeUndefined()
  })
})

describe('SessionCreateRow', () => {
  it('shows preparation without arguments or actions', () => {
    const view = render(<SessionCreateRow {...props({
      phase: 'preparing', callId: 'call-session-create', name: 'session_create', turn: 1, step: 1, time: 1, subCalls: [],
    })} />)
    expect(view.getByText('创建会话')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('[data-tool="session_create"]')?.getAttribute('data-state')).toBe('preparing')
  })

  it('renders a running row summarizing the cwd target', () => {
    const view = render(<SessionCreateRow {...props(running('{"cwd":"/work/alpha"}'))} />)
    expect(view.container.querySelector('[data-tool="session_create"]')?.getAttribute('data-state')).toBe('running')
    expect(view.getByText('/work/alpha')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('falls back to the first argument line when args are malformed', () => {
    const view = render(<SessionCreateRow {...props(running('{"cwd":'))} />)
    expect(view.getByText('{"cwd":')).toBeTruthy()
  })

  it('summarizes a workspace target and falls back to the call id for empty args', () => {
    const byWorkspace = render(<SessionCreateRow {...props(running('{"workspace_id":"ws-alpha"}'))} />)
    expect(byWorkspace.getByText('ws-alpha')).toBeTruthy()
    const emptyWorkspace = render(<SessionCreateRow {...props(running('{"workspace_id":"","cwd":""}'))} />)
    expect(emptyWorkspace.getByText('{"workspace_id":"","cwd":""}')).toBeTruthy()
    const nonObject = render(<SessionCreateRow {...props(running('"plain"'))} />)
    expect(nonObject.getByText('"plain"')).toBeTruthy()
    const empty = render(<SessionCreateRow {...props(running(''))} />)
    expect(empty.getByText('call-session-create')).toBeTruthy()
  })

  it('renders the created summary and opens the session on click', () => {
    openSession.mockClear()
    const view = render(<SessionCreateRow {...props(settled({
      meta: { sessionId: 'session-1', engineId: 'native', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, title: 'GLM work session', reused: false },
    }))} />)
    expect(view.container.querySelector('[data-tool="session_create"]')?.getAttribute('data-state')).toBe('ok')
    expect(view.getByText('native · deepseek-v4-flash · GLM work session')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开会话' }))
    expect(openSession).toHaveBeenCalledWith('session-1')
  })

  it('renders a successful card without the open action when meta is missing', () => {
    const view = render(<SessionCreateRow {...props(settled())} />)
    expect(view.container.querySelector('[data-tool="session_create"]')?.getAttribute('data-state')).toBe('ok')
    expect(view.getByText('{"sessionId":"session-1","engineId":"native","reused":false}')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('renders non-text result blocks and an error-only result without content', () => {
    const image = render(<SessionCreateRow {...props(settled({
      content: [{ type: 'image', attachment: { attachmentId: 'a1' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
    }))} />)
    expect(image.getByText('{')).toBeTruthy()
    const emptyError = render(<SessionCreateRow {...props(settled({
      content: [],
      isError: true,
      error: { name: 'Error', code: 'SESSION_MANAGE_TOOL_FAILED' },
    }))} />)
    expect(emptyError.getByText('Error: SESSION_MANAGE_TOOL_FAILED')).toBeTruthy()
    const emptyOk = render(<SessionCreateRow {...props(settled({ content: [], call: null }))} />)
    expect(emptyOk.getByText('call-session-create')).toBeTruthy()
  })

  it('falls back to the target when the meta summary is empty', () => {
    const view = render(<SessionCreateRow {...props(settled({
      meta: { sessionId: 'session-1', reused: true },
    }))} />)
    expect(view.getByText('/work/alpha')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开会话' }))
    expect(openSession).toHaveBeenCalledWith('session-1')
  })

  it('renders an interrupted result as an error without the open action', () => {
    const view = render(<SessionCreateRow {...props(settled({
      isError: true,
      error: { name: 'AbortError', code: 'interrupted' },
      meta: { sessionId: 'session-1', reused: false },
    }))} />)
    expect(view.container.querySelector('[data-tool="session_create"]')?.getAttribute('data-state')).toBe('error')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('renders an error summary without the open action', () => {
    const view = render(<SessionCreateRow {...props(settled({
      isError: true,
      error: { name: 'Error', code: 'SESSION_MANAGE_MODEL_UNAVAILABLE' },
      content: [{ type: 'text', text: 'model unavailable; call list_models' }],
    }))} />)
    expect(view.container.querySelector('[data-tool="session_create"]')?.getAttribute('data-state')).toBe('error')
    expect(view.getByText('model unavailable; call list_models')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
  })
})
