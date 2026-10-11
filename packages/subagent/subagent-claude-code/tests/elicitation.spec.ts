import { describe, expect, it, vi } from 'vitest'
import { answerClaudeElicitation } from '../src/elicitation.ts'

describe('Claude MCP user input', () => {
  it('validates primitive fields, numeric limits and required answers', async () => {
    const ask = vi.fn(async (..._args: Parameters<Parameters<typeof answerClaudeElicitation>[2]>) => ({ answers: [
      { id: 'count', selected: [], custom: '3' },
      { id: 'enabled', selected: ['true'] },
      { id: 'tags', selected: ['a', 'b'] },
    ] }))
    const result = await answerClaudeElicitation({ serverName: 'fixture', message: 'Choose values',
      requestedSchema: { type: 'object', properties: {
        count: { type: 'integer', minimum: 1, maximum: 5 },
        enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      }, required: ['count', 'enabled'] },
    }, new AbortController().signal, ask)
    expect(result).toEqual({ action: 'accept', content: { count: 3, enabled: true, tags: ['a', 'b'] } })
    expect(ask.mock.calls[0]?.[0]).toMatchObject([{ id: 'count' }, { id: 'enabled' }, { id: 'tags', multiSelect: true }])
  })

  it.each(['99', '1.5', ''])('rejects an invalid required integer %j', async (custom) => {
    const result = await answerClaudeElicitation({ serverName: 'fixture', message: 'Count',
      requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['count'] },
    }, new AbortController().signal, async () => ({ answers: [{ id: 'count', selected: [], custom }] }))
    expect(result.action).toBe('cancel')
  })

  it('declines secret fields before opening the question UI', async () => {
    const ask = vi.fn()
    expect(await answerClaudeElicitation({ serverName: 'fixture', message: 'Password',
      requestedSchema: { type: 'object', properties: { password: { type: 'string', format: 'password' } } },
    }, new AbortController().signal, ask)).toEqual({ action: 'decline' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('requires an explicit URL confirmation and rejects non-HTTP URLs', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'confirm', selected: ['Continue'] }] }))
    const request = { serverName: 'fixture', message: 'Complete authentication', mode: 'url' as const, url: 'https://example.test/auth' }
    expect(await answerClaudeElicitation(request, new AbortController().signal, ask)).toEqual({ action: 'accept' })
    expect(await answerClaudeElicitation({ ...request, url: 'file:///private/file' }, new AbortController().signal, ask))
      .toEqual({ action: 'decline' })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('cannot accept an answer after its owning turn was stopped', async () => {
    const controller = new AbortController()
    await expect(answerClaudeElicitation({ serverName: 'fixture', message: 'Confirm', mode: 'url', url: 'https://example.test/auth' },
      controller.signal, async () => {
        controller.abort(new Error('stopped'))
        return { answers: [{ id: 'confirm', selected: ['Continue'] }] }
      })).rejects.toThrow('stopped')
  })
})
