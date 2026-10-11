/** Project-history summaries generated as ordinary turns in their original Session. */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'

/** Length and cancellation limits for an archive summary. */
export interface ChangelogSummaryConfig {
  /** Maximum Unicode characters accepted in the appended summary body. */
  readonly changelogSummaryMaxCharacters: number
  /** Delay before cancelling the Agent activity, in milliseconds. */
  readonly changelogSummaryTimeoutMs: number
}

/**
 * Ask the original engine to append a project-history entry, verify it, and commit archival.
 * The engine owns context restoration and usage accounting; no history is copied to another model request.
 * File verification and archival run in Agent maintenance after the summary becomes idle,
 * so follow-ups cannot start another turn during that asynchronous work.
 * @param ctx - Host context with the Session controller, durable Session store, and filesystem.
 * @param sessionId - original Session to continue.
 * @param workspacePath - owning project's absolute directory.
 * @param config - maximum summary characters and cancellation deadline.
 * @param commitArchive - archive mutation invoked after file verification, while Agent maintenance is held.
 * @returns resolution after the completed turn is flushed, the entry is verified, and archival commits.
 */
export async function summarizeSessionToChangelog(
  ctx: Context,
  sessionId: SessionId,
  workspacePath: string,
  config: ChangelogSummaryConfig,
  commitArchive: () => Promise<void>,
): Promise<void> {
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  const { agent } = resolved
  const changelogPath = join(workspacePath, 'CHANGELOG.md')
  const heading = `## ${new Date().toISOString()} — Session ${sessionId}`
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    agent.cancel({ kind: 'hook', reason: 'Project changelog summary timed out.' })
  }, config.changelogSummaryTimeoutMs)
  let observe: (() => void) | undefined
  let ownsActivity = false
  let settled = false
  const dispose = ctx.effect(() => () => {
    if (ownsActivity && !settled) agent.cancel({ kind: 'disposed' })
  }, 'workspace: changelog summary')
  try {
    await agent.whenIdle()
    if (timedOut) throw new Error('Project changelog summary timed out.')
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      throw new Error('Cannot summarize this session while messages are queued.')
    }
    const prompt = createUserMessage({
      source: { kind: 'user' },
      content: [{
        type: 'text',
        text: [
          'Summarize this conversation and write the summary directly to the project changelog using your available file or shell tools.',
          `Target file (absolute path): ${JSON.stringify(changelogPath)}. Use this exact path even if your working directory differs.`,
          `Append one Markdown entry with this exact heading: ${heading}`,
          `Below the heading, write 3–5 short Markdown bullets in the conversation language covering the goal, completed changes, important decisions, and unresolved work. The summary body must contain at most ${String(config.changelogSummaryMaxCharacters)} Unicode characters.`,
          'Use the conversation context already available. Read only the target file as needed, preserve all existing content, and append the entry. If the file does not exist, create it with a # Changelog heading. If the exact entry heading already exists, do not duplicate it.',
          'Modify only the target changelog. Do not continue the original task or inspect other project files. After writing, verify the entry was saved and reply with one short confirmation containing the path. If writing fails, report the error and do not claim success.',
        ].join('\n'),
      }],
    })
    let currentTurn: number | undefined
    let summaryTurn: number | undefined
    let reason: TurnEndReason | undefined
    observe = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return
      if (event.type === 'turn/start') currentTurn = event.data.turn
      if (event.type === 'user/message' && event.data.id === prompt.id) summaryTurn = currentTurn
      if (summaryTurn === undefined) return
      if (event.type === 'turn/end' && event.data.turn === summaryTurn) reason = event.data.reason
    })
    await agent.runMaintenance(async signal => {
      ownsActivity = true
      const prepare = agent.prepareExecution?.bind(agent)
      if (prepare !== undefined) await prepare(signal)
      if (timedOut) throw new Error('Project changelog summary timed out.')
      if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
        throw new Error('Cannot summarize this session while messages are queued.')
      }
      agent.followup(prompt)
    })
    await agent.whenIdle()
    settled = true
    clearTimeout(timer)
    await agent.runMaintenance(async signal => {
      await ctx.sessions.flush(agent.session)
      if (timedOut) throw new Error('Project changelog summary timed out.')
      if (reason?.kind !== 'completed') {
        throw new Error(reason?.kind === 'error' ? `Project changelog summary failed: ${reason.error.message}` : 'Project changelog summary did not complete.')
      }
      const target = await ctx.fs.resolve(changelogPath)
      const written = await ctx.fs.stat(target)
      if (written?.type !== 'file') throw new Error(`Project changelog summary did not create a file at "${changelogPath}".`)
      const content = await ctx.fs.readText(target)
      const lines = content.split(/\r?\n/)
      const entryStart = lines.indexOf(heading)
      if (entryStart < 0) throw new Error(`Project changelog summary did not append the expected entry to "${changelogPath}".`)
      const entryLines = lines.slice(entryStart + 1)
      const nextHeading = entryLines.findIndex(line => /^##\s/.test(line))
      const summary = entryLines.slice(0, nextHeading < 0 ? undefined : nextHeading).join('\n').trim()
      if (summary === '') throw new Error(`Project changelog summary appended an empty entry to "${changelogPath}".`)
      if ([...summary].length > config.changelogSummaryMaxCharacters) {
        throw new Error('Project changelog summary exceeded the character limit.')
      }
      signal.throwIfAborted()
      if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
        throw new Error('Cannot archive this session while messages are queued.')
      }
      await commitArchive()
    })
  } finally {
    clearTimeout(timer)
    if (ownsActivity && !settled) {
      agent.cancel({ kind: 'hook', reason: 'Project changelog summary did not settle.' })
      await Promise.allSettled([agent.whenIdle()])
    }
    observe?.()
    dispose()
  }
}
