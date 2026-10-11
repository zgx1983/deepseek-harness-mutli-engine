import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { childSessionMeta, resolveChildAgentOptions } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
    ctx: { get: () => undefined },
  } as unknown as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('child Session metadata', () => {
  function workspaceParent(cwd?: string): Agent {
    const id = SessionId('workspace-parent')
    return {
      ...parentAgent(),
      id,
      session: Session.create(id, undefined, {
        version: SESSION_FORMAT_VERSION,
        id,
        createdAt: 0,
        isSeeded: false,
        ...cwd === undefined ? {} : { cwd },
      }),
    }
  }

  it('inherits the parent workspace cwd when no override is named', () => {
    expect(childSessionMeta(workspaceParent('/lead/checkout'), 2, false)).toMatchObject({
      cwd: '/lead/checkout',
      parentSession: SessionId('workspace-parent'),
      isSeeded: false,
      delegationDepth: 2,
    })
    expect(childSessionMeta(workspaceParent(), 2, false)).not.toHaveProperty('cwd')
  })

  it('stamps a caller-specified cwd over the parent workspace', () => {
    expect(childSessionMeta(workspaceParent('/lead/checkout'), 1, true, '/other/checkout'))
      .toMatchObject({ cwd: '/other/checkout', isSeeded: true })
    expect(childSessionMeta(workspaceParent(), 1, false, '/other/checkout'))
      .toMatchObject({ cwd: '/other/checkout' })
  })
})
