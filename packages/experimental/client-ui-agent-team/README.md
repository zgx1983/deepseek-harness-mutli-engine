---
description: "Use and debug the experimental Web Agent Teams roster, task board, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds one Agent Team action to the Web conversation header. Its panel combines the roster, task board, and native engine child output; the Sidebar Team page stacks a read-only execution flow above the roster and folded task board. When the Lead commits a workflow through `team_workflow_create`, the conversation renders the submitted stages and dependencies as one read-only plan card. It reads the Lead Session's `agentTeam` projection from the shared Session store, where Host projection frames keep it current without a refresh control, and keeps child-history navigation on the stable addressed-subagent path. Choose it through the published experimental Agent Teams bundle. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

The right Sidebar includes a Team page, accessible from its guide or the header panel’s “Show Team in sidebar” action. The page stacks three collapsible areas — execution flow, members, and tasks — with per-area and per-group fold controls, live counts in every collapsed header, and expand-all/collapse-all actions per area. It groups teammates by failed, unknown, running, pending, completed, and idle states; teammate cards sit side by side inside a status group, wrap with the available width, and fall back to one column in a narrow sidebar. Selecting a member opens its continuable Session; the Team page follows navigation. Completion requires at least one assigned task, all assigned tasks completed with recorded starts and ends, and a known stopped Session. Completed task records without execution timestamps remain in Not started; absent timing in older records is not reconstructed. Idle means no assigned work or previously started work that does not meet completion requirements. Header member labels use the same classification as the sidebar. All member groups use single-column lists. The Team sidebar opens only through a user click; child activity and conversation navigation do not open it automatically. An inactive member with unfinished work remains pending. Tasks are associated through immutable, Team-unique member names; mailbox queues and authorization requests have no separate badges. The existing Session handles conversation input, approvals, and interruption.

Member rows show no timing. Task cards show the first start and last end in the browser’s local time, including earlier runs while a reopened task runs again. The description expand/collapse control stays above the description, so its position does not move below expanded content.

Timing labels use Start and End, with local month/day/hour/minute precision. Elapsed time spans the first start to the latest end, or the current time while running; it includes gaps between repeated runs and updates each minute. Task cards omit write-scope lists while retaining overlap warnings.

-----

<a id="use-this-package"></a>
## Use this package

Enable this package through [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md), which supplies the Team service, tools, and Web UI together. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

The panel shows the Lead Session's roster and task board from the shared Session store. Task and roster updates appear while the panel stays open. Opening the panel performs no projection requests. The panel shows a loading notice while the conversation or Session list is loading, and an unavailable notice when no Team value is present afterward.

Roster rows show durable names and phases, with the execution engine in parentheses after each name: external-engine members show the engine id from their `engine:` provider namespace, other members show native, and the Lead is always native. Provisioning and running members use the shared ongoing loader, idle and unstarted members use a person icon, completed members use done, and failed members use error. Live Session status supplies running activity; the shared `modelSelection` projection supplies a model when available. The current conversation carries a Current chat tag and cannot be selected. Selecting the Lead from a teammate conversation opens the Lead Session directly. Selecting an active teammate opens its ordinary continuable child address. The Host validates the parent, child, and mode when history opens; later human prompts use the same addressed-subagent conversation.

### Fold areas and read the execution flow

Every area header keeps its title, total, and short status summary visible while collapsed and stays keyboard-operable with `aria-expanded` and `aria-controls`; collapsing a body that holds focus returns focus to its header, and hidden bodies leave the tab order. The members area folds per status group; the task area folds into running, runnable, and completed groups with waiting-dependency tasks counted inside runnable, completed collapsed by default; the execution flow is collapsed by default and expands from its title. Fold choices persist per Team root Session, area, and group in browser storage, never in the Session log: sibling member conversations share them, different Teams keep their own defaults, live updates never override them, and groups that appear later start from their default.

The flow section renders one read-only node per non-deleted task and one arrow per `blockedBy` prerequisite, layered left-to-right by the longest prerequisite chain with same-layer nodes stacked top-to-bottom in task creation order. Solid arrows mark completed prerequisites and dashed arrows unfinished ones; prerequisites missing from the board become read-only dashed placeholders, and a dependency cycle shows an advisory notice while the task list stays authoritative. Nodes expose title, status, id, and owner through icon-plus-text and an accessible name. The canvas offers fit, zoom in, zoom out, and fullscreen; dragging pans it and the wheel keeps scrolling the sidebar. Layout reruns only when the task set or dependencies change, status and owner updates rewrite node content in place, and fitting happens at mount or on demand so the viewport survives updates. Selecting a node by pointer or keyboard expands the task area and its group, scrolls the matching card into view, and highlights it briefly; selection also lists the node's direct prerequisites and successors.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The read-only task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. Descriptions clamp to one line behind an expand toggle, and long boards scroll inside a bounded list instead of stretching the sidebar. An owner name becomes a control when the current roster resolves it to one durably active member other than the current conversation; activating it opens that member's Session, where the execution output lives. Unclaimed tasks and unresolved names stay plain text, and the card itself remains read-only. The Task board heading stays visible with its task count in both the header panel and the sidebar page; an empty board shows a short description beneath the heading, and a lone member with no tasks uses a single-column panel. Team agents create and update tasks through their tools; the panel provides no task mutation controls. When the projection reports a rejected persisted Team record, the panel shows that failure above the last valid roster and tasks.

### Read the conversation workflow plan card

When the Lead calls `team_workflow_create`, the conversation shows one read-only card at that invocation under the workflow name and task count: every stage becomes a node in call order, and every valid `after` pair becomes a solid neutral arrow. The canvas fits its layout at mount and has no pan, zoom, or selection controls. Cards derive from the logged call arguments, so history replay reproduces them; plans that never created tasks — duplicate stage names or `after` references that are unknown, self, or later stages — leave only the generic tool row. Stages render pending by definition; live statuses remain on the Team dashboard flow.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries and the conversation-header action, Team sidebar type, body, and title through Cordis effects; it mounts no Remote namespace. Disposing the plugin fiber removes these registrations.

The panel renders outside the conversation container and stays within the viewport. Member cards use the shared elevation stroke for their outlines in resting, selected, and hover states. Hovering the trigger opens the panel after 150ms; leaving both trigger and panel closes it after a 120ms grace period. Clicking the trigger pins the panel and moves focus into it. Outside clicks and Escape dismiss the panel; Escape returns focus to the trigger only when focus was inside the panel. In a narrow header, the trigger becomes an icon and opens only on click. The component derives every row from the `useSessions`, `useSessionStatus`, and `useSession` seats: the Lead identity comes from the current Session's subagent address, the Team view from `projectionsBySession[lead].values.agentTeam`, member activity from Session status with the list summary as fallback, and the model from `projectionsBySession[member].values.modelSelection.next`. Each roster row selects its own running state. The member navigation callback opens a roster Session using the current and target Session ids. Switching conversations closes the panel and clears a navigation failure.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, navigation, conversation node, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Projection-derived roster, task board, and engine children |
| [`src/client/TeamDashboard.tsx`](src/client/TeamDashboard.tsx) | `TeamDashboard` stacks the flow graph, folded member groups, and `TaskGroups`; `TeamDashboardTitle` supplies the tab icon and label |
| [`src/client/TeamSection.tsx`](src/client/TeamSection.tsx) | Shared collapsible area with accessible header, counts, and focus return |
| [`src/client/TaskGroups.tsx`](src/client/TaskGroups.tsx) | Folded task groups with board-wide counts and graph-node reveal |
| [`src/client/TaskDependencyGraph.tsx`](src/client/TaskDependencyGraph.tsx) | Dashboard flow graph with fit, zoom, pan, and fullscreen viewing |
| [`src/client/TaskFlowCanvas.tsx`](src/client/TaskFlowCanvas.tsx) | Shared read-only flow svg body behind the dashboard graph and plan cards |
| [`src/client/WorkflowPlanCard.tsx`](src/client/WorkflowPlanCard.tsx) | `WorkflowPlanCard` conversation renderer for one created workflow |
| [`src/client/workflow-definition.ts`](src/client/workflow-definition.ts) | Conversation node definition folding `team_workflow_create` calls into plan cards |
| [`src/client/workflow-plan.ts`](src/client/workflow-plan.ts) | Parser recovering a workflow plan from logged call arguments |
| [`src/client/task-flow.ts`](src/client/task-flow.ts) | Pure task grouping, status mapping, layered graph layout, and fit math |
| [`src/client/fold-state.ts`](src/client/fold-state.ts) | Fold state hooks re-reading stored choices on Team switch |
| [`src/client/collapse-preferences.ts`](src/client/collapse-preferences.ts) | Validated browser-storage envelope for per-Team fold choices |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams bundle](../agent-team-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, and projection behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

## Native child status

The same header and right-sidebar tab show Claude/Codex internal children from the current Session's `engineSubagents` projection. `Roster.tsx` owns shared status grouping and member buttons for native and external children; `EngineSubagents.tsx` provides read-only expandable output, native identity, parent identity when available, model, and progress. Engine children are grouped as running, pending, completed, failed, stopped or unknown. The existing right-sidebar tab opens only when the user selects it. They do not enter Recent or project lists and have no Harness Session navigation or execution controls. Displayed output is bounded and limited to what the native protocol publishes; missing fields are omitted. Native Team member navigation and classification remain with their existing adapters.

Engine-owned children and Team controls share one header dropdown. Native entries expand received output and status without advertising a continuable Harness child Session. Member rows carry teammate Session navigation; other Harness subagent sessions do not appear in this panel. The same panel provides the manual sidebar action. When the Team projection is present, the standalone subagent count trigger is hidden; ordinary sessions keep it.

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No mailbox timeline** — the projection view carries roster and tasks only; peer messages are not shown.
- **Late plugin activation** — after enabling Agent Teams in an already-open conversation, reload the page to receive its Team projection.
- **Model availability** — a model appears only when the shared store has a durable selection or request for that member. Missing cold-cache values stay absent until normal Session loading or a live update supplies them.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.
- **Display-only flow graph** — nodes never dispatch, claim, or complete tasks; owner associations stay name-based and open no Session, and no approval states exist in the projection.
- **Plan cards are creation snapshots** — a workflow plan card never updates after creation; live statuses stay on the Team dashboard flow graph.
- **Fold preferences are per-browser** — stored in `localStorage` under one versioned key; clearing site data resets them, and the header panel and sidebar share the same per-Team choices only after their next mount.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The Host projection is authoritative and the package owns disposable UI registrations.
