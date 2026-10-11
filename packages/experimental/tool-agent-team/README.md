---
description: "Twelve tools that let the model create, message, and coordinate teammates, for compositions mounting the experimental Team plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

## Summary

This package lets the model create named teammates, send them messages, inspect availability, wait for progress, interrupt stuck work, and coordinate through a shared task board, including one-call workflow creation and ready-task dispatch. Every team member receives the same twelve tools and guidance for coordinating in a shared workspace. Choose it when the model should operate a team only after you explicitly request one. It replaces legacy subagent controls with the same tool names, so compositions that need both must disable the legacy definitions. The package is published under its experimental name and provides no stability guarantee.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package on top of `@deepseek-ai/dsh-experimental-agent-team` when the model should run a team through tools. Once mounted, every team member — the Lead and each teammate — gets the same twelve tools plus the same coordination policy. `spawn_teammate` prefixes the initial task with the teammate’s role and name.

### When to choose it

Choose it when the model should create and coordinate teammates by itself rather than a human driving subagent controls. Avoid it when the legacy global subagent tools with the same names must stay available: the team tools replace them for team members, so a composition that wants both must disable the legacy definitions. The fixed policy creates teammates only when you explicitly ask for a team or teammates, so ordinary tasks never trigger delegation on their own.

### Smallest working example

The smallest addition to an existing composition is the two-package fragment from the [agent-team README](../agent-team/README.md#smallest-working-setup): durable session storage, the team domain package, and this package. The plugin itself takes two optional settings:

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| Field | Default | Meaning |
|---|---|---|
| `freshProvider` | `spawn` | Provider that starts fresh teammates |
| `forkProvider` | `fork` | Provider that starts fork teammates |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-agent-team) is the exhaustive source for every accepted field and its JSDoc.

Try it by asking the Lead model: "create a teammate named reviewer to check the diff, then send reviewer the change summary". The model calls the creation tool and then the messaging tool.

### What the model can do

The twelve tools group into five capabilities:

- **Create a teammate** — `spawn_teammate` takes a name, a description, the initial task, and an optional `cwd` naming the directory the teammate works in; the named task is claimed for the member in the same transaction that reserves the member, and a creation failure releases the claim; only the Lead can call it.
- **Start work** — `dispatch_task` is the single execution start (Lead only): it re-checks the task on the latest revision, claims it for one teammate, delivers the work order with wake authorization, and can interrupt a running target first; refusals carry structured reasons — blockers, owner, status, target — and never start a process, and an identical repeat returns the original assignment without re-delivery.
- **Send messages** — `send_message` delivers discussion only: a running member reads it at the nearest step boundary, an inactive member keeps it queued until its next authorized start, and the result carries the `targetStatus` sampled before delivery.
- **See and wait** — `list_agents` returns each member’s `target`, availability, and the in-progress task it owns through `currentTaskId`; `wait_agent` waits for the next team change; `interrupt_agent` stops a teammate's current turn (Lead only).
- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, `team_task_update`, and `team_task_approve` create, inspect, update, and approve shared tasks. Task inputs, outputs, write scopes, and approval gates are persisted with the task.
- **Orchestrate a pipeline** — `team_workflow_create` atomically stores named stages and their dependencies in one call (Lead only); the Host scheduler starts explicitly assigned ready tasks after approval and can wait for a task to complete, be deleted, or time out.

Creation and listing results identify members by `target`, with no member Session ID. Use that value in message and interrupt calls or the task tools’ `owner` parameter; task `ownerName` uses the same value. `inactive` means no turn is executing, whether the member is loaded or must be resumed; it does not describe task completion or outcome. `provisioning` and `failed` describe member creation. Any member can message any other member and use the task board; only the Lead creates and interrupts teammates. Task updates keep the domain's owner and revision checks, so an outdated edit is rejected instead of overwriting newer work.

Task results include optional `startedAt` and `endedAt` Unix epoch timestamps in milliseconds, derived from task status transitions. Tasks that never entered `in_progress` omit both fields. The shared output schema accepts these fields for creation, reads, listing, and updates.

### What success and failure look like

Sending a message succeeds as soon as it is safely stored: the result is `accepted` (delivered now) or `queued` (waiting for the target's next authorized start), and a queued message must not be resent. `dispatch_task` returns `dispatched` with the claimed task, a structured `refusal` — blocked, owned, non-pending, unknown target — carrying the blocker ids or owner name, or an idempotent repeat of the original assignment; when `wait` is set it also reports whether the wait ended by completion or timeout. `wait_agent` returns `noProgress` right away when no other member is running or provisioning, telling the caller to dispatch a teammate first; otherwise it waits for the next change and the caller re-reads state afterward. Task edits based on an outdated revision are rejected rather than overwriting newer work.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on three commitments:

- **Scoped, not global.** Every registration lives on the member Agent's own `ctx`; installation uses the member identity available when the Agent is published.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Tools delegate to `ctx.agentTeams`, which enforces Lead authority and revision checks; the adapter adds no weaker path.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the fixed policy text, and the twelve scoped tool registrations |
| — | No runtime invariant companion is published; the Team service owns durable and authorization relations. |

### Policy and tools

One `team:policy` section on the member scope states the shared coordination rules; the fixed text and the twelve tool registrations are declared in [`src/index.ts`](src/index.ts). The twelve tool schemas are registered in scopes recognized as Team members at publication. Scoped registrations with the same names as the legacy global continuable-subagent controls shadow those globals for team members only.

### Scoped registration and teardown

`maybeInstall` runs for every live Agent and subscribes to `agent/created`; it skips Agents without Team membership. Disposal of an Agent runs the installed disposer, and plugin HMR disposes every installed scope before reinstall. Each disposer unwinds registrations in reverse order, so a failed install cannot leave a partial scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team) — every tool schema the model receives.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — model-facing, scoping, and isolation decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Teammate model and launch tools

#### What the model sees

`list_teammate_models` returns configured provider/model ids, display names, and compatible registered engines. Engines listed for a provider already satisfy its URL requirements — the claude engine needs an `anthropic-api` endpoint (a Claude-compatible URL) and the codex engine an `openai-compatible` endpoint (a Codex URL) — and each listed engine names the endpoints it requires. Providers carrying a configuration diagnostic or failing model discovery are omitted, so the catalog holds only usable routes; naming such a provider explicitly fails with the discovery cause. For an explicit model request, the Lead calls this tool and interprets user abbreviations and requirements before passing exact ids to `spawn_teammate`. Local discovery checks engine compatibility without choosing a name match. Tool events retain the catalog in the session; the Claude/Codex Team MCP bridge exposes the same discovery tool. `spawn_teammate` accepts `engine`, `provider`, `model`, `reasoning_effort`, and `cwd`. External engines allow fresh context only and select their session-backed providers; native context retains configured fresh/fork providers. Supply provider and model together to route a child explicitly; both omitted inherits the Lead route. The tool passes the selected names unchanged and does not resolve them against a local model catalog. A `cwd` — absolute, or relative to the Lead working directory, naming an existing directory — re-anchors the teammate: its session header, tools, and project instructions (AGENTS.md/CLAUDE.md) resolve against that directory, the resolved value is recorded on the roster row, and without it every member runs in the Lead working directory. Claude/Codex members receive the scoped Team tools through a process-owned `dsh_team` MCP connection. Their initial prompt identifies the Lead and the shared-task workflow; all calls retain the member identity, permissions, and revision checks of the Harness tool pipeline.

#### Token effect

Discovery results retain the catalog JSON once per `list_teammate_models` tool event, and launch arguments travel as compact `spawn_teammate` parameter JSON; the tools add no other model-visible text.

#### KV Cache effect

Tool results and launch requests append after the reusable request prefix of shared policy, schemas, and history, so discovery and launch calls do not invalidate earlier cached content; the roster row and session header record the launched route without altering that prefix.

### Team policy and tools

#### What the model sees

One shared system policy states the explicit-delegation requirement, shared-filesystem and per-teammate cwd behavior, filesystem stale-version recovery, Bash/formatter/codegen risk, task and write-scope coordination, Steer delivery, the no-retry mailbox rule, and the Lead's duty to wait before answering. All twelve Team schemas are identical for Leads and teammates; execution enforces Lead-only operations. `spawn_teammate` prefixes its initial user message with `<system-reminder>\nYou are teammate "<name>".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>`, followed by a blank line and the task. The prefix contains no Team id and works when runtime context is disabled. Forks inherit history without an additional Lead identity message.

#### Token effect

Fixed policy and schema cost on every Team member request. The initial identity text follows ordinary history through later steps, cold recovery, and compaction; the plugin neither scans for it nor reinserts it. Tool calls add compact JSON roster, task, wait, or receipt results. Peer content is retained by the Team domain in the target's history.

#### KV Cache effect

With the same provider/model, shared system policy, and tool schemas, a fork retains the parent request prefix and appends the initial task with its identity prefix. Tool results and peer messages append after the reusable request prefix. Sessions recorded with identity inside the system prompt can change that prefix on their first request under this layout; actual provider cache hits remain best-effort.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One-shot child tool visibility** — in-process one-shot children receive their subagent descriptor after publication. Team installation can therefore mistake them for Leads and expose Team policy and tools. Calls are rejected once the descriptor identifies them as non-members. Correcting installation timing is deferred.

These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **No autonomous team creation** — ordinary tasks do not trigger delegation unless the user explicitly requests it.
- **No Web controls** — browser roster and task-board presentation is outside this runtime package.
- **Experimental prototype with no stability promise** — the package is public, but its schemas can change freely while it incubates.

<a id="dev-note"></a>

The Lead creates all planned tasks with `team_task_create` or `team_workflow_create` before dispatch, including blocked tasks; ordinary todos do not populate the Team board. `team_workflow_create` validates stage names and forward references before creating any task, so an invalid workflow leaves the board unchanged. `dispatch_task` assigns a checked ready task to one teammate, optionally interrupts the target's current turn, delivers the work order, and can wait for completion or deletion. `spawn_teammate` accepts `task_id` to reuse an unowned pending ready task and rejects blocked or already owned tasks before creating a member. Without `task_id`, it creates an initial shared task as before. The initial prompt supplies the task ID for claiming and completion. Tasks remain pending if member creation fails. User-requested review is a Lead coordination requirement: dependency completion does not authorize dispatch before explicit confirmation.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
