/** Session-owned MCP transport for the Harness Team tools of an external Agent. */
import { randomUUID, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolResult } from '@deepseek-ai/dsh-tools'

/** Fixed Team capability names; unrelated Harness tools never cross this transport. */
const TEAM_TOOLS = new Set([
  'list_teammate_models', 'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
])

/**
 * The personal-assistant execution channel: a session bound to one task
 * execution reports progress and submits its deliverable through this scoped
 * tool, so external engines drive the same closed loop as the native loop.
 */
const EXECUTION_TOOLS = new Set(['task_execution'])

/** The bridge exposes every present Team tool plus the scoped execution channel. */
function bridgeableNames(names: readonly string[]): string[] {
  return names.filter(name => TEAM_TOOLS.has(name) || EXECUTION_TOOLS.has(name))
}

/** A process-owned endpoint; calls are admitted only during its owning Agent turn. */
export interface TeamToolBridge {
  /** Loopback MCP URL passed to the native process. */
  readonly url: string
  /** Per-process bearer credential, never stored in session events. */
  readonly authorization: string
  /**
   * Admit tools for one turn and return an asynchronous cancellation/drain operation.
   * @param signal - the owning turn cancellation.
   * @returns a finalizer that cancels and drains every admitted call.
   */
  beginTurn(signal: AbortSignal): () => Promise<void>
  /** Stop admission, drain tools, and release the listener and scoped presentation. */
  close(): Promise<void>
}

/**
 * Start a loopback MCP endpoint when the Agent has scoped Team tools or a
 * bound personal-assistant execution channel.
 * @param agent - immutable caller identity for all exposed tools.
 * @param signal - process preparation cancellation.
 * @returns a process-owned endpoint, or undefined when no bridgeable tool exists.
 */
export async function startTeamToolBridge(agent: Agent, signal: AbortSignal): Promise<TeamToolBridge | undefined> {
  const tools = agent.ctx.get('tools')
  if (tools === undefined
    || (tools.get('team_task_get', agent) === undefined && tools.get('task_execution', agent) === undefined)) {
    return undefined
  }
  signal.throwIfAborted()
  const restorePresentation = agent.ctx.tools.presentAs('native')
  const authorization = `Bearer ${randomBytes(32).toString('hex')}`
  const calls = new Set<Promise<unknown>>()
  const connections = new Set<McpServer>()
  const catalogs = new Set<string>()
  let active: { controller: AbortController; signal: AbortSignal } | undefined
  let closing = false
  let closePromise: Promise<void> | undefined
  const drain = async (): Promise<void> => { await Promise.allSettled([...calls]) }
  const http = createServer((request, response) => {
    if (closing || request.url !== '/mcp' || request.headers.authorization !== authorization) {
      response.writeHead(403).end()
      return
    }
    const hasExecution = tools.get('task_execution', agent) !== undefined
    const instructions = 'These are Harness Team tools. Use list_agents to discover members; use team_task_get or team_task_list before revision-checked task updates. Use list_teammate_models to choose exact provider/model ids and a compatible engine from a user description before an explicit model request. Only the Lead may spawn or interrupt teammates. A queued message is already durable: do not resend it. wait_agent observes future progress and does not wake idle members.'
      + (hasExecution
        ? ' task_execution is bound to the one task execution this session owns: report progress and blockers through it, and submit the deliverable through it once the goal is actually met — a turn that ends without a submission does not complete the task.'
        : '')
    const mcp = new McpServer({ name: 'dsh-team', version: '1.0.0' }, { capabilities: { tools: {} }, instructions })
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    connections.add(mcp)
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => {
      const allowed = new Set(bridgeableNames(tools.schemas(agent).map(tool => tool.name)))
      const visible = tools.schemas(agent).filter(tool => allowed.has(tool.name))
        .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }))
      const schemaJson = JSON.stringify(visible)
      if (!catalogs.has(schemaJson)) {
        agent.session.append('engine/item-settled', {
          nativeItemId: `dsh-team-catalog:${randomUUID()}`, revision: 1, category: 'harness-tool-catalog',
          payload: { schemaJson, instructions },
        })
        catalogs.add(schemaJson)
      }
      return Promise.resolve({ tools: visible })
    })
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const turn = active
      const name = request.params.name
      if (closing || turn === undefined || turn.signal.aborted || !(TEAM_TOOLS.has(name) || EXECUTION_TOOLS.has(name))) {
        return { isError: true, content: [{ type: 'text', text: 'No active owning Team turn or unavailable bridged tool.' }] }
      }
      const schema = tools.schemas(agent).find(tool => tool.name === name)
      if (schema === undefined) return { isError: true, content: [{ type: 'text', text: 'Team tool is unavailable in this member scope.' }] }
      const callId = ToolCallId(`dsh-team-${randomUUID()}`)
      const args = request.params.arguments ?? {}
      const invocation = (async () => {
        agent.session.append('engine/item-settled', {
          nativeItemId: callId, revision: 1, category: 'harness-tool-call',
          payload: { name, argumentsJson: JSON.stringify(args), schemaJson: JSON.stringify(schema) },
        })
        let result: ToolResult
        try {
          result = await tools.execute({ agent, callId, name, arguments: args,
            signal: AbortSignal.any([turn.signal, extra.signal]) })
        } catch (error: unknown) {
          result = { isError: true, content: [{ type: 'text', text: String(error) }] }
        }
        agent.session.append('engine/item-settled', {
          nativeItemId: callId, revision: 2, category: 'harness-tool-result',
          payload: { name, contentJson: JSON.stringify(result.content), isError: result.isError },
        })
        return { isError: result.isError, content: result.content.map(block => ({
          type: 'text' as const, text: block.type === 'text' ? block.text : JSON.stringify(block),
        })) }
      })()
      calls.add(invocation)
      try { return await invocation } finally { calls.delete(invocation) }
    })
    const handle = async (): Promise<void> => {
      try {
        // SDK implementations expose optional callbacks as explicit undefined.
        await mcp.connect(transport as Transport)
        await transport.handleRequest(request, response)
      } finally {
        if (response.writableEnded || response.destroyed) {
          connections.delete(mcp)
          await mcp.close()
        } else response.once('close', () => {
          connections.delete(mcp)
          void mcp.close().catch((error: unknown) => { agent.ctx.logger.warn(`Team MCP close failed: ${String(error)}`) })
        })
      }
    }
    void handle().catch((error: unknown) => {
      agent.ctx.logger.warn(`Team MCP request failed: ${String(error)}`)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
    })
    signal.throwIfAborted()
  } catch (error: unknown) {
    http.close()
    restorePresentation()
    throw error
  }
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Team MCP listener has no TCP address')
  const bridge: TeamToolBridge = {
    url: `http://127.0.0.1:${address.port}/mcp`, authorization,
    beginTurn(turnSignal) {
      if (closing || active !== undefined) throw new Error('Team MCP already owns a turn or is closing')
      const controller = new AbortController()
      const turn = { controller, signal: AbortSignal.any([turnSignal, controller.signal]) }
      active = turn
      return async () => {
        controller.abort(new Error('Team turn ended'))
        await drain()
        if (active === turn) active = undefined
      }
    },
    close() {
      closePromise ??= (async () => {
        closing = true
        active?.controller.abort(new Error('Team process closed'))
        await drain()
        await Promise.allSettled([...connections].map(connection => connection.close()))
        http.closeAllConnections()
        try {
          await new Promise<void>((resolve, reject) => {
            http.close((error) => {
              if (error === undefined) resolve()
              else reject(error)
            })
          })
        } finally { restorePresentation() }
      })()
      return closePromise
    },
  }
  return bridge
}
