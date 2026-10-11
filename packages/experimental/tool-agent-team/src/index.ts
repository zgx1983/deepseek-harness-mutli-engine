/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/** Tool routing configuration. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
})

/** Model-facing collaboration guidance shared by Lead and teammates. */
const POLICY = `Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.

Before spawning a teammate with an explicitly requested model or vendor, call list_teammate_models. Interpret the user's abbreviated names and requirements against the returned provider ids/names, model ids/names, and compatible engines. You choose the exact provider, model, and engine; pass their ids to spawn_teammate. Choose only pairs the catalog lists: the claude engine works only with providers serving an anthropic-api endpoint (a Claude-compatible URL) and the codex engine only with providers serving an openai-compatible endpoint (a Codex URL); the catalog already omits engines whose URL a provider does not declare and providers that are misconfigured or undiscoverable, so do not guess an engine for a provider that does not list it. Do not copy an ambiguous human alias into model or inherit the Lead model for an explicit request. If several routes fit and the requirements do not distinguish them, ask the user. Omit provider and model together only when inheriting the Lead route is intended.

The Team Lead must create all known planned tasks with team_task_create or team_workflow_create before starting work, including tasks waiting on dependencies. team_workflow_create validates and atomically stores every stage and dependency in one event; team_task_create records blocked_by with existing task ids. Ordinary todos do not populate the Team task board. dispatch_task explicitly starts work by atomically re-checking readiness on the latest revision, claiming the task for one teammate, and delivering its work order; a blocked, approval-gated, already-owned, or non-pending task is refused with the reason instead of started, and repeating an identical dispatch returns the original assignment without re-delivering. The Host scheduler also starts explicitly assigned tasks after dependencies and user approval are satisfied. Use team_task_approve for a persisted approval gate. spawn_teammate(task_id) claims a ready unowned task for the new member at creation and refuses blocked or approval-gated tasks. If the user requires review before later work, wait for explicit user confirmation before approving or dispatching those tasks, even after their dependencies complete.

The Team Lead and all teammates share one filesystem. Every member runs in the Lead working directory unless spawn_teammate passes cwd; pass cwd when the user names a directory or the delegated task belongs to another project checkout, so the teammate loads that project's AGENTS.md/CLAUDE.md instructions and runs its tools there (a fork teammate's inherited history was recorded under the Lead workspace). Edits are immediately visible to every member, so use absolute paths when members run in different working directories. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message delivers discussion only: a running target reads it at the nearest step boundary, and an inactive target keeps it queued until its next authorized start — it never starts a process or a turn, so work requests go through dispatch_task and deliberate preemption uses interrupt_agent before dispatching. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, perform the work on tasks you own, then complete with the latest revision; task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; dispatch_task starts required inactive teammates. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

/**
 * One model-facing roster row. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    cwd: { type: 'string' },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
    currentTaskId: { type: 'string', description: 'Id of the in-progress task owned by this member, if any.' },
  },
} as const

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView, currentTaskId?: string): InferValue<typeof MEMBER_VIEW_SCHEMA> {
  const { id: _id, name, ...details } = member
  return { target: name, ...details, ...currentTaskId === undefined ? {} : { currentTaskId } }
}

/** Find the in-progress task currently owned by one named member. */
function findCurrentTaskId(ctx: Context, agent: Agent, targetName: string): string | undefined {
  const tasks = ctx.agentTeams.listTasks(agent)
  return tasks.find(task => task.ownerName === targetName && task.status === 'in_progress')?.id
}

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    approval: { type: 'string', required: true, enum: ['not-required', 'pending', 'approved', 'rejected'] },
    inputPaths: { type: 'array', required: true, items: { type: 'string' } },
    outputPaths: { type: 'array', required: true, items: { type: 'string' } },
    generation: { type: 'integer', required: true },
    executionState: { type: 'string', required: true, enum: ['none', 'reserved', 'starting', 'running', 'ended', 'failed', 'stopped', 'startup-unconfirmed'] },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
    startedAt: { type: 'number' },
    endedAt: { type: 'number' },
  },
} as const

/** One workflow stage request; `after` names must resolve to earlier stages. */
const WORKFLOW_STAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true, description: 'Unique stage name referenced by later stages.' },
    subject: { type: 'string', description: 'Task title; defaults to the stage name.' },
    description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
    after: { type: 'array', items: { type: 'string' }, description: 'Earlier stage names that must complete first.' },
    write_scopes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Advisory workspace-relative file or directory prefixes this stage expects to modify.',
    },
    input_paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files required before execution.' },
    output_paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative results required before completion.' },
    approval_required: { type: 'boolean', description: 'Require explicit user approval before execution.' },
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
    targetStatus: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
  },
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

const WORKFLOW_CREATE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workflow: { type: 'string', required: true },
    stages: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          task: { ...TASK_VIEW_SCHEMA, required: true },
        },
      },
    },
  },
} as const

/** One mailbox delivery receipt from the unified dispatch entry. */
const DISPATCH_DELIVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

/** Structured dispatch refusal with the repair facts the caller needs. */
const DISPATCH_REFUSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      required: true,
      enum: ['unknown-target', 'member-inactive', 'task-not-found', 'task-status', 'task-blocked', 'task-approval', 'task-owned'],
    },
    memberPhase: { type: 'string', enum: ['provisioning', 'active', 'failed'] },
    taskStatus: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    blockedBy: { type: 'array', items: { type: 'string' } },
    ownerName: { type: 'string' },
  },
} as const

const DISPATCH_TASK_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dispatched: { type: 'boolean', required: true, description: 'True when this call claimed the task and delivered the work order.' },
    task: { ...TASK_VIEW_SCHEMA },
    refusal: { ...DISPATCH_REFUSAL_SCHEMA },
    delivery: { ...DISPATCH_DELIVERY_SCHEMA },
    interrupted: {
      type: 'object',
      additionalProperties: false,
      properties: {
        previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
      },
    },
    waitTimedOut: {
      type: 'boolean',
      description: 'Present only when wait was requested; true when the task was still unfinished at the timeout.',
    },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Config>): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: POLICY,
    }))

    register(scoped.tools.register(defineTool({
      name: 'list_teammate_models',
      description: 'List locally configured provider and model ids/names with compatible registered engines. Engines listed for a provider already satisfy its URL requirements: the claude engine needs an anthropic-api endpoint (a Claude-compatible URL) and the codex engine an openai-compatible endpoint (a Codex URL). Providers with a configuration error or failing model discovery are omitted. Use this catalog to interpret the user request before selecting an explicit teammate route. Optional provider is an exact id, not a fuzzy search. Catalog membership is advisory; explicit unlisted model ids remain supported.',
      parameters: {
        provider: { type: 'string', description: 'Optional exact provider id; omit to inspect all configured providers.' },
        engine: { type: 'string', enum: ['native', 'claude', 'codex'], description: 'Optional engine id; include only providers with compatible endpoints.' },
      },
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
      async execute(args, exec) {
        const llm = scoped.get('llm')
        if (llm === undefined) throw new Error('Cannot discover teammate models: llm service is unavailable')
        const engines = scoped.agents.listEngines()
        if (args.engine !== undefined && !engines.some(engine => engine.id === args.engine)) {
          throw new Error(`Teammate engine "${args.engine}" is not registered`)
        }
        const providers = llm.listProviders()
        if (args.provider !== undefined && !providers.some(provider => provider.id === args.provider)) {
          throw new Error(`Unknown provider "${args.provider}"; available provider ids: ${providers.map(provider => provider.id).join(', ')}`)
        }
        /* Entries carrying a configuration diagnostic are not usable routes;
           the configuration UI reports the same rows as not ready. */
        const misconfigured = new Set(llm.listConfigurableProviders()
          .filter(entry => entry.error !== undefined).map(entry => entry.provider))
        const catalog = []
        for (const provider of providers) {
          exec.signal.throwIfAborted()
          if (args.provider !== undefined && provider.id !== args.provider) continue
          if (misconfigured.has(provider.id)) continue
          const compatible = engines.filter(engine => engine.endpoints.length === 0
            || provider.endpoints?.some(endpoint => engine.endpoints.includes(endpoint.id)) === true)
          if (args.engine !== undefined && !compatible.some(engine => engine.id === args.engine)) continue
          let models
          try {
            models = await llm.listModels(provider.id)
          } catch (error) {
            // A failing route is unusable; an explicitly named provider fails loud instead.
            if (args.provider !== undefined) {
              throw new Error(`Provider "${provider.id}" is not currently usable: model discovery failed (${String(error)})`)
            }
            continue
          }
          catalog.push({
            provider: provider.id, name: provider.name,
            engines: compatible.map(engine => ({ id: engine.id, name: engine.name,
              ...engine.endpoints.length === 0 ? {} : { requires: engine.endpoints } })),
            models: models.map(model => ({ id: model.id, name: model.name,
              ...model.description === undefined ? {} : { description: model.description } })),
          })
        }
        exec.signal.throwIfAborted()
        return JSON.stringify(catalog)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate and atomically claim its shared task on the latest revision. With task_id, the task must be unowned, pending, and ready; the claim commits with the member record and a creation failure releases it. Without task_id, one initial shared pending task is created first. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        task_id: { type: 'string', description: 'Existing unowned pending ready task to claim for the new member. Omit only when no planned task exists.' },
        engine: { type: 'string', enum: ['native', 'claude', 'codex'], description: 'Execution engine for a fresh teammate. Defaults to native; external engines do not support fork context.' },
        cwd: {
          type: 'string',
          description: 'Optional working directory for the teammate: absolute, or relative to the Lead working directory, naming an existing directory. The teammate runs its tools and loads that project\'s AGENTS.md/CLAUDE.md instructions there. Omit to run in the Lead working directory.',
        },
        provider: { type: 'string', description: 'Exact provider id chosen by you from list_teammate_models after interpreting the user request. Supply provider and model together.' },
        model: { type: 'string', description: 'Exact model id chosen by you from list_teammate_models, not an abbreviated user alias. Passed unchanged without local name matching. Omit both provider and model only to inherit the Lead route. An explicitly supplied unlisted model id remains supported.' },
        reasoning_effort: { type: 'string', description: 'Reasoning effort id for the child route; omit to use its compatible default.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const context = args.context ?? 'fresh'
        const engine = args.engine ?? 'native'
        if (context === 'fork' && engine !== 'native') throw new Error('External teammates support fresh context only')
        if ((args.provider === undefined) !== (args.model === undefined)) {
          throw new Error('Supply provider and model together')
        }
        for (const value of [args.provider, args.model, args.reasoning_effort]) {
          if (value !== undefined && value.trim() === '') throw new Error('Child model selection fields must be non-empty')
        }
        const selectedRoute = args.model === undefined ? undefined : { provider: args.provider, model: args.model }
        if (ctx.agentTeams.membership(agent).role !== 'lead') throw new Error('only the Team Lead can create teammates')
        // An omitted task_id keeps the standalone-initial-task behavior: the
        // task is created first, then claimed with the member atomically.
        const task = args.task_id === undefined
          ? await ctx.agentTeams.createTask(agent, { subject: args.description, description: args.prompt })
          : ctx.agentTeams.getTask(agent, TeamTaskId(args.task_id))
        const result = await ctx.agentTeams.spawnTeammate(agent, {
          name: args.name,
          description: args.description,
          prompt: [
            { type: 'text', text: engine !== 'native' ? `<system-reminder>
You are teammate "${args.name.trim()}". Your Team Lead is named "lead". Use the Harness Team tools from the dsh_team MCP server to discover members, read and claim shared tasks, update them using the latest revision, and send messages to your Lead or teammates. Complete the delegated task and report the outcome in your final response; the Team Lead also receives your completion automatically.
</system-reminder>

` : `<system-reminder>
You are teammate "${args.name.trim()}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

` },
            { type: 'text', text: `Your shared task is ${task.id}. It is already assigned to you. Read it with team_task_get, perform the work, and complete it with team_task_update after meeting its acceptance criteria. Do not create a duplicate task for this assignment.\n\n${args.prompt}` },
          ],
          context,
          provider: engine === 'claude' ? 'engine:claude' : engine === 'codex' ? 'engine:codex'
            : context === 'fork' ? config.forkProvider : config.freshProvider,
          taskId: task.id,
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          ...selectedRoute === undefined && args.reasoning_effort === undefined ? {} : { agentOptions: {
            ...selectedRoute?.provider === undefined ? {} : { provider: selectedRoute.provider, model: selectedRoute.model },
            ...args.reasoning_effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(args.reasoning_effort) },
          } },
          signal: exec.signal,
        })
        return { member: modelMember(result.member) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'send_message',
      description: 'Send one durable discussion message to another Team member. A running target reads it at the nearest step boundary; an inactive target keeps it queued until its next authorized start, so this never starts a process or a turn. Work requests belong in dispatch_task.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member target returned by spawn_teammate or list_agents, including lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'send_message')
        const targetStatus = ctx.agentTeams.listMembers(agent).find(m => m.name === args.target)?.status ?? 'inactive'
        const result = await ctx.agentTeams.sendMessage(agent, {
          target: args.target,
          content: [{ type: 'text', text: args.message }],
          signal: exec.signal,
        })
        return { ...result, targetStatus }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation. The currentTaskId field names the in-progress task owned by that member, if any.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      execute(_args, exec) {
        const agent = callingAgent(exec.agent, 'list_agents')
        const members = ctx.agentTeams.listMembers(agent)
        return Promise.resolve(members.map(member =>
          modelMember(member, findCurrentTaskId(ctx, agent, member.name))))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        // Preserve TeamService's authoritative timeout validation before the
        // model-only no-progress shortcut.
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        // The active-peer read and waiter registration must remain one synchronous
        // span; awaiting between them can lose the only peer-status edge.
        const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
          member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
        if (!hasActivePeer) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'no-active-peer' as const,
              message: NO_ACTIVE_PEER_MESSAGE,
            },
          }
        }
        return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
      },
      output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
      execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
        input_paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files required before this task can start.' },
        output_paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files or directories that must exist before task completion.' },
        approval_required: { type: 'boolean', description: 'Require explicit user approval before this task can start.' },
        assignee: { type: 'string', description: 'Existing teammate target. The scheduler starts it automatically after dependencies and approval are satisfied.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.input_paths === undefined ? {} : { inputPaths: args.input_paths },
          ...args.output_paths === undefined ? {} : { outputPaths: args.output_paths },
          ...args.approval_required === undefined ? {} : { approvalRequired: args.approval_required },
          ...args.assignee === undefined ? {} : { assignee: args.assignee },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list. Completing a task automatically notifies teammates whose tasks just became ready.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'assign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only assign/reassign; omit to unassign.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'team_task_update')
        const result = await ctx.agentTeams.updateTask(agent, {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
        })
        return result
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_approve',
      description: 'Ask the user to approve or reject the persisted execution gate for one task. The scheduler starts it only after an explicit approval.',
      parameters: { task_id: { type: 'string', required: true, description: 'Task waiting for approval.' } },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.requestTaskApproval(
          callingAgent(exec.agent, 'team_task_approve'), TeamTaskId(args.task_id), exec.signal,
        )
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_workflow_create',
      description: 'Create a pipeline of shared tasks with dependencies in one call. Each stage becomes one task; a stage listed in another stage\'s after blocks that task until the earlier stage completes. Validate stage names and dependencies before creation so an invalid workflow creates no tasks. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Workflow name returned with the created stages.' },
        stages: {
          type: 'array',
          required: true,
          items: WORKFLOW_STAGE_SCHEMA,
          description: 'Ordered pipeline stages. Each after entry must name an earlier stage.',
        },
      },
      output: jsonOutput(WORKFLOW_CREATE_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'team_workflow_create')
        if (ctx.agentTeams.membership(agent).role !== 'lead') {
          throw new Error('only the Team Lead can create workflows')
        }
        const names = new Set(args.stages.map(stage => stage.name))
        if (names.size !== args.stages.length) throw new Error('workflow stage names must be unique')
        const earlier = new Set<string>()
        for (const stage of args.stages) {
          if (stage.name.trim().length === 0) throw new Error('workflow stage names must be non-empty')
          for (const dependency of stage.after ?? []) {
            if (!earlier.has(dependency)) {
              throw new Error(`stage "${stage.name}" depends on unknown or later stage "${dependency}"`)
            }
          }
          earlier.add(stage.name)
        }
        const nameToId = new Map<string, TeamTaskId>(args.stages.map((stage, index) => [stage.name, TeamTaskId(`task-${index + 1}`)]))
        const requests = args.stages.map(stage => ({
          subject: stage.subject ?? stage.name,
          description: stage.description,
          ...stage.after === undefined || stage.after.length === 0 ? {} : {
            blockedBy: stage.after.map(name => nameToId.get(name)).filter(id => id !== undefined),
          },
          ...stage.write_scopes === undefined ? {} : { writeScopes: stage.write_scopes },
          ...stage.input_paths === undefined ? {} : { inputPaths: stage.input_paths },
          ...stage.output_paths === undefined ? {} : { outputPaths: stage.output_paths },
          ...stage.approval_required === undefined ? {} : { approvalRequired: stage.approval_required },
        }))
        const tasks = await ctx.agentTeams.createTasks(agent, requests)
        return { workflow: args.name, stages: tasks.map((task, index) => {
          const stage = args.stages[index]
          if (stage === undefined) throw new Error(`workflow stage ${index + 1} has no matching request`)
          return { name: stage.name, task }
        }) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'dispatch_task',
      description: 'The single execution start: atomically re-check a shared task on the latest revision, claim it for one teammate, optionally interrupt their current turn first, and deliver the work order with wake authorization. Blocked, owned, non-pending, or unknown targets are refused with structured reasons and no process starts. Repeating an identical dispatch returns the original assignment without re-delivery. Only the Team Lead may call this tool.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
        task_id: { type: 'string', required: true, description: 'Shared task id to dispatch.' },
        message: { type: 'string', description: 'Self-contained work order; defaults to the task subject and description.' },
        force: { type: 'boolean', description: 'If true, interrupt a running target first. This cancels the target\'s current turn before the work order is delivered.' },
        wait: { type: 'boolean', description: 'If true, wait until the task is completed or deleted, or the timeout expires.' },
        timeout_ms: { type: 'integer', description: 'Maximum milliseconds to wait when wait is true. Defaults to 300000.' },
      },
      output: jsonOutput(DISPATCH_TASK_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'dispatch_task')
        const timeoutMs = args.timeout_ms ?? 300_000
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw new Error('timeout_ms must be a positive safe integer')
        }
        const result = await ctx.agentTeams.dispatchTask(agent, {
          taskId: TeamTaskId(args.task_id),
          target: args.target,
          ...args.message === undefined ? {} : { instruction: [{ type: 'text', text: args.message }] },
          ...args.force === true ? { interrupt: true } : {},
          signal: exec.signal,
        })
        let waitTimedOut: boolean | undefined
        if (args.wait === true && result.refusal === undefined) {
          const deadline = Date.now() + timeoutMs
          let finished = false
          let current = result.task
          while (!finished && Date.now() < deadline) {
            await ctx.agentTeams.waitForChange(agent, Math.max(10_000, Math.min(deadline - Date.now(), 60_000)), exec.signal)
            const latest = ctx.agentTeams.getTask(agent, TeamTaskId(args.task_id))
            current = latest
            finished = latest.status === 'completed' || latest.status === 'deleted'
          }
          waitTimedOut = !finished
          return { ...result, ...(current === undefined ? {} : { task: current }), waitTimedOut }
        }
        return result
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
