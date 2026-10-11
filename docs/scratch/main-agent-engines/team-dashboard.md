# Agent Team dashboard: detailed design

English | [中文](team-dashboard.zh.md)

Design reference with partially implemented targets; this proposal is not the current feature inventory. See the [owning package README](../../../packages/experimental/client-ui-agent-team/README.md) for behavior and the [feature migration and iteration checklist](../../../worktree-feature-list.md) for implemented and remaining work. Original design review: 2026-10-01; status checked: 2026-10-04.

## Summary

Keep the existing conversation layout and input experience. Add a Team tab to the existing right sidebar: grouped teammate rows open their persistent Sessions in the center column. The Team remains rooted at the Lead Session while the user talks to any member.

## Contents

- [Current implementation](#current)

- [Layout and navigation](#layout)

- [Status classification](#status)

- [Data and subscriptions](#data)

- [Failures and interaction](#interaction)

- [Implementation ownership](#implementation)

- [Delivery and acceptance](#acceptance)

<a id="current"></a>

## Current implementation

The existing [TeamAction](../../../packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx) is a conversation-header popup with roster rows and a read-only task board. `registerAgentTeamUi` in [mount.ts](../../../packages/experimental/client-ui-agent-team/src/client/mount.ts) derives the Lead from the subagent address and opens member Sessions with `mode: continuable`. Reuse that navigation rather than introducing a separate chat renderer.

The [Team types](../../../packages/experimental/agent-team/src/types.ts) distinguish durable member phases (`provisioning`, `active`, `failed`) from task states (`pending`, `in_progress`, `completed`, `deleted`). The client projection does not expose task `ownerId`, queue depth, member turn errors, or authorization-wait status. These require explicit data work; a stopped turn does not mean completed work.

Multi-engine persistent members are a separate [design dependency](persistent-agent-teams.md). This dashboard can first operate with existing native members; it must not imply that Claude/Codex teammates are already supported.

<a id="layout"></a>

## Layout and navigation

Use the existing left workspace/session browser, central conversation, and resizable right sidebar. Register a Team tab through `sidebarRightTabs`, `sidebar.right.pane.tab`, and `sidebar.right.pane.tab.title`; give it the existing users icon. Do not register a parallel right column or replace `AppFrame`.

```text
+-------------------+----------------------------------+-------------------------+
| Workspaces        | Lead > selected member           | Team / Tasks            |
| Sessions          | Existing conversation transcript | Running (2)             |
|                   |                                  | Pending (1)             |
|                   | Existing composer                | Completed (3)           |
|                   | Model / permissions / cancel     | Idle / Failed / Unknown |
+-------------------+----------------------------------+-------------------------+
```

The header shows Team name (or Lead title), a persistent Lead shortcut, selected-member name, and member/task counts. The Lead sits above the grouped teammate list and does not inflate teammate counts. Each row shows name, runtime label, engine and model when known, task progress, queued-message count when available, and an unread badge. Never infer engine from the legacy `provider: spawn/fork` field.

Clicking a valid row calls the shared `openTeammate` action; the center switches to that Session and its ordinary input, authorization, stop and model controls. The right panel remains on the same Team. Clicking Lead returns to the parent Session. Browser history follows existing workspace navigation; scroll position and unsent drafts follow existing Session storage. Opening a row never sends a prompt or wakes its process.

When navigating outside this Team, release its subscription and resolve the new Session’s Team. Preserve an explicitly selected Team tab for related members; do not force the sidebar open on every streamed update. A first user click on the Team header action may open the tab. At narrow widths use the existing rightbar overlay and close behavior; selecting a member closes the overlay so its conversation is visible.

<a id="status"></a>

## Status classification

Compute one display group per member from separate lifecycle, live execution, work, and connectivity facts. A task owner must be a Session identity; `ownerName` is only display text. Use this priority order, independent of whether the process is alive.

| Priority / group | Rule | Row detail |
|---|---|---|
| 1 / Failed | Provisioning failure or explicit latest execution/recovery failure | Reason and recovery action; retain task progress |
| 2 / Unknown | Required live state has not loaded or connection is stale | Last known state, never completed by default |
| 3 / Running | A turn is active, including waiting for approval or user answer | Executing / awaiting approval / awaiting answer |
| 4 / Pending | Provisioning, queued input, or any owned non-completed task | Preparing / queued / dependency blocked / ready |
| 5 / Completed | At least one owned task, all completed, no active turn or queued input | Task-complete; Session remains continuable |
| 6 / Idle | Valid inactive member with no pending work and no explicit completion evidence | Idle, including stopped or unassigned members |

Deleted tasks do not count. A member with both completed and pending tasks belongs to Pending when inactive. A member executing after its tasks completed belongs to Running. New input removes the Completed group immediately after durable acceptance. A final assistant message, a tool result, process exit, or silence never creates completion evidence. For taskless assignments, retain Idle until the team scheduler has an explicit durable assignment-completion record; do not invent such a record in the UI.

Keep stable roster order within groups, expandable group headings with counts, and a visible current-member marker. Use a short regroup delay only for rapidly changing live updates, with an explicit UI Config value; selected rows remain identifiable when moved. Search filters name, model and engine without altering counts of the full Team.

<a id="data"></a>

## Data and subscriptions

Retain the Lead projection once while the Team tab is mounted. Resolve `teamRootId` from the existing subagent address initially; the persistent-member design must provide an explicit root association for revived members. Read roster/tasks from `agentTeam`, engine/model from member selection projections, and execution activity from shared Session status. Subscribe to lightweight member status; do not open every transcript or resume every engine merely to paint rows.

Add `ownerId` to the client task view and its producers/consumers together. Add a team-scoped queued-input summary and freshness marker when the scheduler can authoritatively supply them. Authorization indicators should reuse existing interaction projections if they identify the member Session; otherwise add a dedicated summary. Keep these optional enhancements explicitly unknown until available, rather than reading private inbox internals in browser code.

The dashboard is a projection consumer. Group labels and collapse/search preferences are client state and do not become model-visible input. Membership, assignments and message delivery remain backend-owned durable records. Any additional durable type requires the repository persistence review; updating a display view alone does not authorize changing historical logs.

<a id="interaction"></a>

## Failures and interaction

| State | Presentation and action |
|---|---|
| No teammates | Show Lead and a short hint to request teammates in the conversation; do not auto-create |
| Initial loading | One roster skeleton, no guessed zero counts |
| Projection failure / disconnect | Retain last valid rows; compact inline notice and Retry; mark stale status |
| Provisioning | Disabled Session navigation until binding exists; clear pending label |
| Failed member with retained Session | Allow opening diagnostics and history; explicit retry only when backend supports it |
| Session missing or inaccessible | Keep roster row; report navigation failure through persistent app Toast |
| Approval / question | Row badge opens member Session; existing conversation UI owns response |
| Interrupt | Existing selected-Session stop action; never broadcast to the Team implicitly |
| Resume failure / delivery uncertain | Show member failure and existing recovery flow; never replay input automatically |

Use theme tokens and existing StateDot, Tag, Tooltip, skeleton and Toast primitives; text labels accompany color. Feature font weight stays at 500 or below. Keyboard users can reach group toggles, every navigable row and the Lead shortcut; use `aria-current` for the selected Session. Announce meaningful status changes without reading each streamed token. Verify light/dark contrast, macOS titlebar clearance, Windows chrome, narrow widths, focus visibility and scroll containment.

<a id="implementation"></a>

## Implementation ownership

Extend the existing experimental Team UI plugin. No new standalone dashboard application, loop implementation or parallel conversation store is needed. The proposed files below are implementation targets, not files already created.

| Capability | Existing owner / symbol | Proposed change |
|---|---|---|
| Team root and navigation | `client-ui-agent-team/src/client/mount.ts`, `registerAgentTeamUi`, `openTeammate` | Extract shared injected actions; register Team rightbar type, body and title with effect disposers |
| Existing header entry | `client-ui-agent-team/src/client/TeamAction.tsx`, `TeamAction` | Header opens Team tab; avoid two independent roster implementations |
| Group rules | Proposed `client-ui-agent-team/src/client/team-status.ts`, `classifyTeamMember` | Pure deterministic classification with unknown and priority semantics |
| Sidebar content | Proposed `TeamDashboard.tsx`, `TeamMemberRow.tsx`, CSS modules | Grouped roster, selected row, Lead shortcut and compact task section |
| Data lifetime | Proposed `team-dashboard-store.ts` | Root-scoped subscriptions and teardown; retain no full child transcripts |
| Task identity and summary | `agent-team/src/types.ts`, `task-view.ts`, `projection.ts`, `teamProjectionView` | Expose owner identity consistently; add authoritative summaries separately |
| Copy and deployment | `client-ui-agent-team/src/client/locales.ts`, package README pair and profile composition | Typed bilingual labels, right-sidebar dependency and activation requirements |

Use [document-preview registration](../../../packages/client/ui-sidebar-documentpreview/src/client/index.ts) as the existing rightbar registration example and [AppFrame](../../../packages/client/ui-layout/src/client/AppFrame.tsx) as the geometry owner. Confirm the rightbar tab definition’s exact lifecycle API during implementation before adding dependencies; do not change layout geometry to host Team data.

<a id="acceptance"></a>

## Delivery and acceptance

Implement in three reviewable stages: first expose task ownership and shared root/navigation; second add a native-member sidebar with honest unknown states; third consume persistent multi-engine scheduler summaries and interaction badges when that backend exists. Keep per-member engine/provider/model selection in the persistent-team design, rather than inventing an independent selector in this dashboard.

| Acceptance area | Required evidence |
|---|---|
| Classification | Every priority, mixed tasks, taskless idle, new input after completion, stale status and deleted tasks |
| Navigation | Lead to member to sibling to Lead; correct input target; draft and scroll retained; unrelated Session releases Team |
| Lifecycle | Provisioning, failure with readable history, missing Session, reconnect, plugin unmount and subscription teardown |
| Interaction | Member approval/question, targeted interrupt, queued input, resume failure and delivery-uncertain recovery |
| Product output | Keyless recorded-session snapshot of grouped roster and navigation; native first, each external engine after integration |
| Presentation | Browser and Desktop, light/dark, keyboard, narrow window, OS chrome, large roster and bounded subscriptions |

## Dev Note

Open product choices: keep the task board beneath the roster or make it a second inner tab; expose direct wake/retry only after backend admission and idempotency are specified. This document contains no executed UI acceptance or runtime implementation. Existing-source claims were checked by reading the linked code; implementation must supply the evidence above.
