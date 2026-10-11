# Agent Team workflow and immediate dispatch improvements

English | [中文](agent-team-workflow-dispatch.zh.md)

## Problem

`tool-agent-team` currently exposes only low-level primitives: `spawn_teammate`, `send_message`, `team_task_create`, `team_task_update`, and `wait_agent`. Real use exposes two structural gaps:

1. **Dependencies are not written into the shared task graph.** The Lead keeps the design → development → build → test order in memory and with manual `send_message` calls; `blocked_by` on `team_task_create` is frequently omitted. `team_task_list` then shows no dependency between design/dev and build/test, and a downstream task can be dispatched before its dependencies complete.

2. **There is no atomic operation that immediately drives a subagent.** `send_message` only enters a mailbox: a running target queues the message instead of processing it immediately; only an inactive target starts a turn. The Lead cannot make a teammate start work immediately the way @-mentioning a person in a chat does, especially when that teammate is stuck in a long turn.

3. **Observability is insufficient.** `list_agents` returns only `running/inactive/provisioning/failed` without the currently claimed task, mailbox queue depth, or current-turn duration, so the Lead cannot tell whether a teammate is working or hung.

## Proposal

Add three high-level capabilities at the `tool-agent-team` layer without changing the persistent semantics of the `agent-team` service:

### 1. `team_workflow_create` — build a dependency pipeline in one call

Input:

```ts
{
  name: string
  stages: Array<{
    name: string
    subject?: string
    description: string
    after?: string[]      // names of dependency stages
    write_scopes?: string[]
  }>
}
```

Behavior:
- Validate that stage names are unique.
- Create the tasks in order, resolving each `after` entry to an already-created task id and writing it into `blocked_by`.
- Return `{ workflow, stages: [{ name, task }] }`.

One call then builds the complete design/development/build/test dependency chain instead of the Lead maintaining `blocked_by` by hand.

### 2. `dispatch_task` — readiness check + claim + forced wake + optional wait

Input:

```ts
{
  target: string          // teammate name
  task_id: string
  message?: string        // work order; defaults to the task subject + description
  force?: boolean         // if the target is running, interrupt first
  wait?: boolean          // block until the task completes
  timeout_ms?: number     // defaults to 300000
}
```

Behavior:
1. `team_task_get` checks that the task is pending and ready; a blocked task fails immediately.
2. CAS-claim the task for the target.
3. If `force` is true and the target is running, `interrupt_agent` first.
4. `send_message` delivers the work order.
5. If `wait` is true, loop `wait_agent` and re-read `team_task_get` after each wakeup until the task is completed/deleted or the timeout expires.

This merges “check dependencies → claim → forced wake → wait for result” into one atomic operation and directly fixes “tester received the message but is not working”.

### 3. `send_message` and `list_agents` enhancements

- `send_message` gains a `force` parameter and returns `targetStatus`, so the Lead knows the target's status before delivery.
- `list_agents` gains `currentTaskId`, showing the in-progress task each member currently owns, so the Lead can see at a glance who is doing what.

## Alternatives

### Why not make the `agent-team` service event-driven directly?

The service has no native support for “wake the owner when a task becomes ready”, because blocked tasks cannot be claimed or assigned. Service-level auto-wake would require:
- allowing the Lead to pre-assign an owner on a blocked task (a new `assign` action or relaxing `reassign`'s `taskReady` check), or
- the service sending a system message when a task becomes ready.

Both changes would cross the `agent-team` and `tool-agent-team` packages and affect the persistent event format. This proposal stays at the tool layer first; `dispatch_task` and `team_workflow_create` solve 80% of the orchestration problem, and service-level event-driven wake can be a later upgrade.

### Why not add `team_task_subscribe`?

A subscription/push model would be friendlier to model calls, but requires event subscription and owner-wake mechanics in `agent-team`. Tool-layer `dispatch_task(wait: true)` already lets the Lead block and wait, with simpler semantics and no service contract change.

## Acceptance criteria

- `team_workflow_create` creates multi-stage tasks with correct `blocked_by` in one call; duplicate stage names and unknown dependencies produce clear errors.
- `dispatch_task` rejects a task that is not ready; on success the task is `in_progress`, owned by the target, and the message is delivered.
- `dispatch_task({ force: true })` interrupts a running teammate before sending the message.
- `send_message({ force: true })` likewise interrupts before delivery and returns `targetStatus`.
- Each member row from `list_agents` carries `currentTaskId` only when that member owns an in-progress task.
- Existing tests keep passing; new tool tests cover workflow, dispatch, force-send, and currentTaskId.

## Risks

- `force` interrupts the current turn and can lose unsaved intermediate results; the documentation and tool descriptions must state that this is forced preemption.
- `dispatch_task(wait: true)` blocks the Lead turn for a long time; a reasonable default timeout and user interruption are required.
- Enriching `send_message`/`list_agents` output changes the model-visible schema; the tool catalog and related tests must be updated together.

## Open questions

- Should the service support pre-assigning owners on blocked tasks to provide true “wake the owner when ready”?
- Should `list_agents` also expose finer-grained state such as `pendingMessageCount` or `turnStartedAt`? This requires the `agent-team` service to expose mailbox and turn metadata.
- Should `team_workflow_create` auto-spawn a teammate per stage? This proposal only creates tasks; spawning stays explicit with the Lead for flexibility.
