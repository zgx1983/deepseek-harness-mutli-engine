/** Workflow plan identity parsed from a logged `team_workflow_create` invocation. */
import type { TeamTaskId, TeamTaskStatus } from '@deepseek-ai/dsh-experimental-agent-team/client'

/** One plan stage resolved to its durable task id and prerequisites. */
export interface WorkflowPlanTask {
  readonly id: TeamTaskId
  /** Stage name later stages reference through `after`. */
  readonly name: string
  readonly subject: string
  /** Every stage is pending at creation; live status stays on the dashboard. */
  readonly status: TeamTaskStatus
  readonly blockedBy: readonly TeamTaskId[]
}

/** Complete plan submitted through one `team_workflow_create` invocation. */
export interface WorkflowPlan {
  readonly callId: string
  readonly name: string
  readonly tasks: readonly WorkflowPlanTask[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stage ids follow the tool's assignment rule: stage n becomes `task-<n+1>`. */
function planTaskId(index: number): TeamTaskId {
  return `task-${index + 1}` as TeamTaskId
}

/**
 * Read a workflow plan from untrusted logged arguments. Stages whose `after`
 * references an unknown, later, or self stage never created tasks, so they
 * parse as nothing rather than as a graph with a dangling or cyclic edge.
 * @param event - Native call or PTC dispatch event from Session history.
 * @returns the submitted plan, or undefined for unrelated or malformed data.
 */
export function workflowPlan(event: { readonly type: string; readonly data: unknown }): WorkflowPlan | undefined {
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') return undefined
  const data = event.data
  if (!record(data) || data.name !== 'team_workflow_create') return undefined
  const callId = event.type === 'tool/call' ? data.callId : data.subCallId
  if (typeof callId !== 'string' || callId === '') return undefined
  let args: unknown = data.arguments
  if (event.type === 'tool/call') {
    if (typeof args !== 'string') return undefined
    try { args = JSON.parse(args) as unknown }
    catch (_error) { return undefined /* Malformed model JSON remains in the generic tool row. */ }
  }
  if (!record(args) || typeof args.name !== 'string' || !Array.isArray(args.stages) || args.stages.length === 0) return undefined
  const stages: { readonly name: string; readonly subject: string; readonly after: readonly string[] }[] = []
  const stageIndex = new Map<string, number>()
  for (const stage of args.stages) {
    if (!record(stage) || typeof stage.name !== 'string' || stage.name === '') return undefined
    if (stageIndex.has(stage.name)) return undefined
    const subject = stage.subject === undefined ? stage.name : stage.subject
    if (typeof subject !== 'string' || subject === '') return undefined
    const after = stage.after === undefined ? [] : stage.after
    if (!Array.isArray(after) || after.some(entry => typeof entry !== 'string')) return undefined
    stageIndex.set(stage.name, stages.length)
    stages.push({ name: stage.name, subject, after })
  }
  const tasks: WorkflowPlanTask[] = []
  for (const [index, stage] of stages.entries()) {
    const blockedBy: TeamTaskId[] = []
    for (const name of stage.after) {
      const dependency = stageIndex.get(name)
      // Unknown, self, and later references mirror the tool's own refusal.
      if (dependency === undefined || dependency >= index) return undefined
      blockedBy.push(planTaskId(dependency))
    }
    tasks.push({ id: planTaskId(index), name: stage.name, subject: stage.subject, status: 'pending', blockedBy })
  }
  return { callId, name: args.name, tasks }
}
