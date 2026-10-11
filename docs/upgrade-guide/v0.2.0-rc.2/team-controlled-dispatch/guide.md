---
kind: upgrade-guide
description: "Team send_message no longer wakes inactive members and loses force; dispatch_task becomes the single execution start with structured refusals; spawn_teammate claims its task."
---

# Team controlled dispatch and no-wake messaging

English | [中文](guide.zh.md)

## Change

Agent Teams start paths are unified behind the Host's dispatch entry, which changes three model-visible tool behaviors and adds one service API.

`send_message` delivers discussion only. A running member reads it at the nearest step boundary; an inactive member keeps it queued until its next authorized start instead of being started or cold-resumed. The `force` parameter is removed — deliberate preemption is `interrupt_agent` followed by `dispatch_task`. Messages that used to resume an idle teammate now return `queued`.

`dispatch_task` is the single execution start. Each call re-checks the task on the latest revision inside one serialized transaction, claims it for the named teammate, and delivers the work order with wake authorization. Blocked, owned, non-pending, and unknown targets return a structured `refusal` (`reason`, `blockedBy`, `ownerName`, `taskStatus`, `memberPhase`) with `dispatched: false` instead of an error, and repeating an identical dispatch returns the original assignment without re-delivering the work order. The result fields `sent`/`targetStatus` become `delivery`/`interrupted`.

`spawn_teammate` claims the task named by `task_id` inside the member's provisioning transaction and releases it when creation fails; a blocked or owned task refuses the spawn (`TEAM_TASK_NOT_DISPATCHABLE`). The initial task prompt now states the task is already assigned, so the member no longer claims it.

On the service face, `ctx.agentTeams.dispatchTask(caller, request)` is new, and `SendTeamMessageRequest` gains `wake` — peer sends default to no-wake, and only the dispatch entry passes wake authorization. Claude and Codex teammates receive the same rules through the `dsh_team` MCP bridge.

Affected users: any composition mounting the experimental Team packages, scripts or prompts that called `send_message` with `force` or relied on messages waking idle teammates, and code calling the Team service API directly.

## Migration

1. Replace `send_message { force: true }` preemption with `interrupt_agent` on the target followed by `dispatch_task` for the work order.
2. Replace message-based work handoff with `dispatch_task`; a plain message to an inactive member now returns `queued` and no longer starts a process.
3. Read dispatch refusals from the structured result (`refusal.reason` with `blockedBy` or `ownerName`) instead of catching errors, and treat a repeated dispatch as idempotent rather than an error.
4. Recompile against the updated service types: `dispatchTask` is added and `SendTeamMessageRequest` carries `wake`.
