/**
 * Session-manage service error containment and model-safe translation.
 *
 * @module @deepseek-ai/dsh-tool-session-manage/service-boundary
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

/** Stable model-facing failure codes for every session-manage tool. */
export type SessionManageErrorCode =
  | 'SESSION_MANAGE_INVALID_ARGS'
  | 'SESSION_MANAGE_PROJECT_NOT_FOUND'
  | 'SESSION_MANAGE_ENGINE_NOT_FOUND'
  | 'SESSION_MANAGE_MODEL_UNAVAILABLE'
  | 'SESSION_MANAGE_CREATE_FAILED'
  | 'SESSION_MANAGE_TITLE_INVALID'
  | 'SESSION_MANAGE_TOOL_FAILED'

/** One expected, model-recoverable session-manage failure. */
export class SessionManageError extends HarnessError {
  declare readonly code: SessionManageErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: SessionManageErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

const UNPRINTABLE_SERVICE_ERROR = '[unprintable session manage failure]'

/**
 * Remote failure codes this tool translates into recovery guidance instead of
 * the generic failure. Unknown codes stay generic; their diagnostics only
 * reach the host log.
 */
const SAFE_REMOTE_FAILURES: Record<string, (error: { readonly message: string }) => SessionManageError> = {
  'workspace/not-found': () => new SessionManageError(
    'workspace is not registered; call list_projects for the known project ids',
    'SESSION_MANAGE_PROJECT_NOT_FOUND',
  ),
  'engine/not-found': error => new SessionManageError(
    `${error.message}; call list_engines for the registered engine ids`,
    'SESSION_MANAGE_ENGINE_NOT_FOUND',
  ),
  'session/model-unavailable': error => new SessionManageError(
    `${error.message}; call list_models with the session engine_id for the routable provider and model ids`,
    'SESSION_MANAGE_MODEL_UNAVAILABLE',
  ),
  'session/writer-held': error => new SessionManageError(
    `${error.message}; the blank session could not be adopted and a fresh create also failed`,
    'SESSION_MANAGE_CREATE_FAILED',
  ),
  'session/engine-conflict': error => new SessionManageError(
    `${error.message}; the blank session could not be adopted and a fresh create also failed`,
    'SESSION_MANAGE_CREATE_FAILED',
  ),
  'session/conflict': error => new SessionManageError(
    `${error.message}; the blank session could not be adopted and a fresh create also failed`,
    'SESSION_MANAGE_CREATE_FAILED',
  ),
  'session/workspace-attach-failed': error => new SessionManageError(
    error.message,
    'SESSION_MANAGE_CREATE_FAILED',
  ),
  'session/title-invalid': error => new SessionManageError(error.message, 'SESSION_MANAGE_TITLE_INVALID'),
  'gateway/bad-request': error => new SessionManageError(error.message, 'SESSION_MANAGE_INVALID_ARGS'),
}

/**
 * Report whether one failed blank-session adoption may fall back to a fresh
 * create. These are the adoption races the Web client also recovers from.
 * @param error - the rejection from `session.create` with an explicit session id.
 * @returns true when a fresh create may proceed.
 */
export function isRecoverableAdoptionFailure(error: unknown): boolean {
  const failure = remoteErrorOf(error)
  return failure !== undefined
    && (failure.code === 'session/writer-held'
      || failure.code === 'session/engine-conflict'
      || failure.code === 'session/conflict')
}

async function call<Value>(
  ctx: Context,
  signal: AbortSignal,
  operation: string,
  invoke: () => Value | Promise<Value>,
): Promise<Value> {
  signal.throwIfAborted()
  try {
    const value = await invoke()
    signal.throwIfAborted()
    return value
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw sanitizeError(ctx, operation, error)
  }
}

function sanitizeError(ctx: Context, operation: string, error: unknown): Error {
  const generic = genericFailure()
  const diagnostic = fullError(error)
  try {
    ctx.logger.warn(`tool-session-manage: ${operation} failed: ${diagnostic}`)
    if (error instanceof SessionManageError) return error
    const failure = remoteErrorOf(error)
    if (failure !== undefined) {
      const translate = SAFE_REMOTE_FAILURES[failure.code]
      if (translate !== undefined) return translate(failure)
    }
  } catch {
    return generic
  }
  return generic
}

function genericFailure(): HarnessError {
  return new HarnessError('session manage operation failed', 'SESSION_MANAGE_TOOL_FAILED')
}

function fullError(error: unknown): string {
  try {
    return renderFullError(error)
  } catch {
    return UNPRINTABLE_SERVICE_ERROR
  }
}

function renderFullError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const diagnostics: string[] = []
  const seen = new Set<Error>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    diagnostics.push(current.stack ?? String(current))
    current = current.cause
  }
  /* v8 ignore next -- defensive containment for a cyclic Error.cause graph */
  if (current instanceof Error) diagnostics.push('[circular error cause]')
  else if (current !== undefined) diagnostics.push(renderFullError(current))
  return diagnostics.join('\nCaused by: ')
}

/** Model-safe host-service invocation and error translation boundary. */
export const serviceBoundary = { call, sanitizeError, isRecoverableAdoptionFailure }
