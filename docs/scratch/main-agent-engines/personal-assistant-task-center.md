# Personal assistant sidebar and hierarchical task design

English | [中文](personal-assistant-task-center.zh.md)

## Table of contents

- [Summary and scope](#section-1)
- [Current implementation and gaps](#section-2)
- [Page structure and navigation](#section-3)
- [Overview and task cards](#section-4)
- [Parent-child tasks and execution model](#section-5)
- [States, dependencies and acceptance](#section-6)
- [Task details and actions](#section-7)
- [Complete lists, history and search](#section-8)
- [Pagination and concurrent consistency](#section-9)
- [Data structures and persistence](#section-10)
- [Query and mutation interfaces](#section-11)
- [Storage queries and migration](#section-12)
- [Refresh, responsive layout and accessibility](#section-13)
- [Implementation order and ownership](#section-14)
- [Acceptance matrix and performance targets](#section-15)
- [Dev note and pre-implementation decisions](#section-16)

<a id="section-1"></a>

## Summary and scope

Status: designed, not implemented. Date: 2026-10-05. This proposal defines the personal-assistant sidebar, parent and child task details, complete task lists, history search and pagination. It preserves the full conversation in the middle column, shared sidebar, fixed Native coordinator Session and fixed working directory. Implementation status belongs in the [feature list](../../../worktree-feature-list.md).

The assistant page shows decisions requiring the user, current execution, queued work and recent results. A task may contain multiple child tasks, each with multiple execution attempts. Users can navigate from summaries to complete details and search paginated active and historical tasks.

Scope includes two task levels, dependencies within one parent, acceptance, execution records, result references, filtering and server pagination. It excludes arbitrary nesting, cross-parent dependencies, calendar automation, due reminders, recurring tasks, merged Agent Team data, artifact full-text search and new engine selection. The UI must not present placeholders as supported capabilities.

<a id="section-2"></a>

## Current implementation and gaps

This proposal records the task-center design from 2026-10-05. The plugin now provides a project and token-usage dashboard; its current behavior is documented in the [plugin README](../../../plugins/dsh-personal-assistant/README.md). The task-center implementation and storage links described in this proposal were removed.

Persistence contains a flat tasks table with pending, running, review, attention, done and cancelled states and per-task runs. Dashboard workItems are single-item projections, not actual child tasks; execution retries are not children either. Existing records lack parentId, dependencies, independent completion timestamps, acceptance history and structured result indexes. These projections cannot establish parent-child relationships.

The proposal requires business data and query capabilities, not just CSS or renamed runs. Earlier vertical-layout and JSON-file descriptions do not govern this implementation. Coordinator lifecycle follows the current README.

<a id="section-3"></a>

## Page structure and navigation

The shared sidebar retains one assistant tab. Its fixed header contains the title, new-task action and overflow menu, followed by status counts and Overview / All tasks / History views. Counts represent active parents; child issue counts are labeled separately to prevent double counting. Selecting a count opens All tasks with the corresponding filter.

Overview orders Decisions needed, Running, Next and Recent results, optionally followed by recent execution activity. All tasks supports complete management; History defaults to done and cancelled parents. Details replace the list within the sidebar and preserve a back action and source view. Execution Sessions open through shared conversation navigation; returning restores assistant details.

The read-only working directory moves into More / Assistant information. The overflow menu can also offer refresh and expand/collapse all. Global shortcuts do not contain task cancellation, stopping or deletion. Existing shared sidebar resizing, collapse and full-screen behavior remains available.

```text
个人助理                              ＋任务  ⋯
需处理 2     执行中 3     待验收 1
[概览]          [全部任务]          [历史]
需要你处理                           折叠
  任务 A · 1 个子任务失败 · 查看原因
正在执行                             折叠
  任务 B · 2/5 完成 · 已运行 8 分钟
接下来                               折叠
  任务 C · 等待前置任务完成
最近成果                             折叠
  任务 D · 已验收 · 查看结果
```

The diagram is illustrative, not current data or an implemented interface.

<a id="section-4"></a>

## Overview and task cards

Decisions needed prioritizes failures, pending acceptance and missing execution projects. A card shows the parent, relevant child, reason and one primary action. Multiple issues under one parent combine into one card with an issue count; selection opens details at the relevant item. Primary actions inspect failure, inspect result or select a project.

Running cards show the parent title, project, overall status, child state distribution, current start time, elapsed time and latest available summary. Progress is labeled Accepted children x/y, not token consumption or work estimates. Without reliable phase events, the UI only reports running; it does not invent analysis, coding or testing phases, percentages or remaining-time estimates.

Next displays pending and dependency-blocked parents with explicit blocking reasons. A non-executable parent starts eligible children, not an additional duplicate Session for the parent. Recent results show summaries, acceptance, completion time and verified artifact or execution Session references.

Overview groups initially show up to three parent cards, controlled by presentation configuration. View all opens the relevant filtered list. Empty groups consume little space. The first-use empty state offers task creation and a request example to paste; filtered-empty and no-task states offer different actions.

<a id="section-5"></a>

## Parent-child tasks and execution model

This iteration has exactly two levels. A root with children is an aggregate parent; a root without children is an executable leaf. Children cannot have children, belong to multiple parents or move between parents. Model-driven decomposition submits the parent, all children and dependencies atomically so later waiting tasks are visible immediately.

Children inherit the parent project; this iteration does not execute children in different projects. Plans may omit a project initially, but Host validates one before execution. Once execution exists, the project cannot change in place. A different project requires a new task, preserving previous Session directories and identities.

Leaves support multiple attempts, each with a new Execution record and independent Session. Task lifecycle differs from attempt lifecycle: Execution ended means an attempt ended, review means awaiting acceptance and done means accepted. Stopped and failed attempts are not completion.

A leaf may become an aggregate parent only without an active execution. Its existing runs remain pre-decomposition history, are not reassigned to children and do not affect child aggregates. Conversion is recorded in activity history. Root lists count the parent once; details count children separately.

<a id="section-6"></a>

## States, dependencies and acceptance

The six business states remain. Separate availability values ready, blocked and needs-project, plus blockedBy, describe execution eligibility. Dependency blocking does not extend the persisted state enum; the UI can display Waiting for dependency. Only leaves execute. dependsOn references siblings under the same parent; self-links, duplicates, cross-parent links and cycles are rejected.

Prerequisites require done by default, meaning accepted results. Review does not unlock successors; cancellation and failure do not satisfy dependencies. A later execution-success policy requires an explicit option rather than changing this default. Acceptance recalculates eligibility. Successors do not start automatically; the user or coordinator explicitly starts ready tasks. Automatic continuation is a later configurable capability.

| Parent state | Aggregate rule, in precedence order |
|---|---|
| cancelled | Parent cancellation completed and no execution remains active. |
| attention | A required child failed or a cancelled required prerequisite blocks completion; running children remain visible in counts. |
| running | No higher-priority issue exists and at least one child is queued/running. |
| review | No active execution, every required child is done, optional children have ended and parent acceptance is pending. |
| pending | Remaining cases, including pending children, dependency waits and children awaiting acceptance. |
| done | Required children are done and the parent has explicit overall acceptance. |

Parent action/review badges are independent of the primary state, so a pending parent can expose child acceptance requests. Accepted-child progress divides done children by all children; cancellation has a separate count. Abandoning a child requires an explicit optional designation; required defaults to true. The required set cannot be empty, and cancellation of every child does not count as overall completion. Optional children must also end as done or cancelled before parent acceptance. Unfinished optional children require explicit cancellation rather than remaining active under a completed parent.

The user accepts the parent result after required children finish. Reopening an accepted child revokes current parent completion and acceptance validity, preserves acceptance history and recalculates successor eligibility. Existing successor results remain. Active successors must stop or end before their prerequisite can reopen, preventing dependency changes during execution.

Cancelling a parent first prevents new execution and requests stopping all active children. Once stops are confirmed, unfinished children and the parent become cancelled while accepted children retain their states. Stop failures remain actionable and retryable rather than reporting complete cancellation. Host rejects deletion, dependency changes and decomposition while relevant execution remains active.

<a id="section-7"></a>

## Task details and actions

Details order Overview, Decisions needed, Children, Results and Execution history. Overview contains title, objective, project, state, creation/update time, first observed execution start, current completion time and acceptance time. Missing real timestamps display Not started or Not completed; updatedAt cannot fabricate start/end times. Unknown endings remain explicitly unknown.

Collapsed child rows show order, title, state, dependencies, latest attempt start/end and duration. Expansion exposes description, required designation, prerequisites, errors, attempt summary, results and actions. State filtering and expand/collapse all are available. Initially load 20 children; load more retains ordering and expansion. A leaf displays its own results and executions directly.

```text
← 返回全部任务                  编辑  ⋯
整理并发布项目文档 · 项目 A
已验收子任务 2/5 · 1 项失败
概况／描述
需要处理：链接校验失败 → 查看原因
子任务                         [全部状态 ▾]
✓ 1 整理需求                   已验收
✓ 2 生成接口文档               已验收
● 3 补充使用示例               执行中
○ 4 汇总文档                   等待任务 3 验收
! 5 校验链接                   执行失败
                 加载更多
成果                           展开
执行历史                       展开
```

Only valid actions appear for each state; unmet start conditions remain visible. Inspect result is the review entry point; acceptance is explicitly available in result details. Retries append Execution records without replacing failures. Asking about a task inserts visible parent/child IDs into a draft, and only user submission calls the model. UI selection never silently sends messages.

Stopping and cancellation have distinct wording and effects. Parent cancellation states the affected child count. Operation failures retain content and use shared Toast feedback; validation remains in the form, and persistent query failures provide compact retry notices. Polling never resets forms or unsent drafts.

<a id="section-8"></a>

## Complete lists, history and search

All tasks defaults to active parents, with an all-states option for ended tasks. History defaults to done and cancelled parents. Both reuse one query/list component while retaining separate filters and page positions. Children do not appear as unrelated root cards.

Queries support keywords, project, parent state, child state, creation/completion ranges and sorting. Initial keywords search parent/child titles and descriptions plus exact IDs, not conversation transcripts, stack traces or artifact content. Child matches return the parent and up to three matching child summaries. Selection locates the child, and each parent appears once.

Default sorting uses createdAt descending and ID as a stable final key. Update time, completion time and title are alternatives, each with ID tie-breaking. Date controls use client-timezone day boundaries and send UTC start-inclusive/end-exclusive intervals. Active tasks without completedAt do not match completion-date filters.

History shows ended state, child summaries, completion/cancellation time, recent results and retained project names. Deleted projects display their recorded name and Project unavailable. History remains readable; re-execution requires a new task with a valid project. History queries the same durable task collection rather than copying records into another database, retaining failures, retries, acceptance and cancellation.

Changing filters or page size resets to page one. Returning from details restores the source view, filters, page and scroll. History searches all persisted tasks, not only the current page or previously loaded client records.

<a id="section-9"></a>

## Pagination and concurrent consistency

Root lists use server page numbers, initially 20 items with a 50-item option and a Config-validated maximum. The footer shows count, current/total pages, previous/next and page jump. Empty results show zero items without a page zero. Children and execution history paginate separately rather than embedding into root responses.

Initial queries return queryId, queryRevision, totalCount, pageSize, pageCount, expiresAt and page items. Host caches short-lived normalized query snapshots that freeze parent membership and ordering. Subsequent pages carry queryId to prevent duplicates, omissions and page shifts after new tasks or updates. Snapshots cache compact IDs/sort records, not full descriptions, runs or conversations. Quotas, lifetimes and maximum results are Config fields.

| Proposed Config field | Initial default | Validation / purpose |
|---|---|---|
| defaultPageSize / maxPageSize | 20 / 50 | Positive integers; default cannot exceed maximum. |
| overviewGroupLimit | 3 | Positive integer bounding group cards. |
| querySnapshotTtlMs | 300000 | Positive integer bounding snapshot lifetime. |
| maxQuerySnapshotsPerIdentity | 16 | Positive integer bounding snapshots per identity. |
| maxQueryResultIds | 50000 | Positive integer; excess requests narrower queries rather than truncation. |
| maxSummaryCharacters | 500 | Positive integer limiting summaries, never IDs or state fields. |
| searchDebounceMs | 250 | Nonnegative integer exposed through client configuration. |

Defaults are proposed starting points and require schema validation. Host configuration also bounds total snapshot memory; excess returns explicit errors. Reuse pollIntervalMs rather than another refresh interval.

Page summaries within a snapshot read current records. A state may no longer match the initial filter, so responses identify changedSinceQuery and the UI offers Updates available / Refresh without silently removing rows. New tasks join only after refresh. Counts describe snapshot matches rather than live totals. Details read latest data with independent version checks.

Child, execution and activity lists use the same snapshot semantics with separate query IDs; load-more cannot splice independently reordered results.

Expired, evicted or restart-lost query IDs return query-expired. Existing content and filters remain, with a refresh action. Refresh creates a new snapshot and preserves the page where possible; out-of-range positions move to the last valid page with notice. Query IDs bind to the authenticated user, Host storage and normalized query and cannot be reused across identities or altered filters.

Responses are bounded. Quota exhaustion or excessive matches return recoverable errors requesting narrower filters rather than silently truncating counts. Pagination reduces response/UI load, not necessarily domain startup memory: current domains maintain in-memory snapshots, and query scalability requires separate measurement.

<a id="section-10"></a>

## Data structures and persistence

These are proposed fields, not existing interfaces. Task IDs, Execution IDs and cross-package references use repository-required branded types; JSON and durable reads validate formats. Tasks, Executions and Activities are independent records. Host computes parent summaries from authoritative records rather than client guesses or model prose.

| Record | Main fields and meaning |
|---|---|
| Task | id, parentId absent for roots, title, description, workspaceId, projectTitleSnapshot, order, required, dependsOn, status, revision, createdAt, updatedAt, startedAt, completedAt, cancelledAt, acceptedAt, acceptedBy. |
| Execution | id, taskId, attempt, sessionId, status, ownerPid, startedAt, endedAt, summary and error; actual ending may be unknown. |
| ResultReference | id, taskId, executionId, kind, title, summary, locator and createdAt; validated Session/artifact references, not arbitrary executable links. |
| TaskActivity | id, taskId, rootTaskId, sequence, type, actor, occurredAt, executionId and relevant changes; creation, decomposition, execution, stopping, acceptance, reopening and cancellation. |
| ParentSummary | root ID, primary state, child counts, action/review counts, availability, latest execution summary and result reference; a rebuildable query projection. |

Task and execution timestamps remain distinct. A container starts at its first observed child execution; completedAt reflects current overall acceptance, with cancellation stored separately. Reopening clears current completion while Activity retains previous completion and acceptance. Execution ending belongs to Execution and acceptance belongs to Task.

This iteration has no hard deletion: cancellation and history preserve management and snapshot references. Future deletion must define tombstones, references and Session retention. Only persisted validated results appear as artifacts; model prose claiming a generated file cannot create a file reference.

<a id="section-11"></a>

## Query and mutation interfaces

Retain the authenticated POST /api/personal-assistant/tasks operation endpoint and add the proposed operations below, updating Host, model tools and client response validation together. Coordinator ensure/recover behavior remains unchanged. Keep dashboardSnapshot until consumers migrate, but stop using it as the complete task-page data source.

| Proposed op | Request essentials | Response / behavior |
|---|---|---|
| overview | Project filter and group limits. | Parent counts, bounded summaries, execution activity and data revision. |
| listTasks | View, filters, sort, page and pageSize; queryId for later pages. | Summaries, matching children and query metadata. |
| getTask | taskId. | Latest overview, aggregates and valid actions without complete execution history. |
| listChildren | parentId, state filters and pagination. | Ordered child summaries and count. |
| listExecutions / listActivity / listResults | taskId, node/subtree scope and pagination. | Paginated records with stable IDs and real timestamps. |
| createPlan | Parent, children, dependencies and requestId. | Atomic plan creation with ID mapping; invalid dependencies reject everything. |
| updateTask / updatePlan | expectedRevision, changes and requestId. | Validated records and aggregates; conflicts never overwrite. |
| startTask / startReadyChildren | IDs, expectedRevision and requestId. | New execution references and ineligible reasons, respecting existing scheduling constraints. |
| acceptTask / reopenTask / stopTask / cancelTask | IDs, expectedRevision and requestId. | State/activity results; parent cancellation may expose an intermediate stopping operation. |

Mutations validate permission, references, allowed states and expectedRevision. requestId deduplication prevents retry-created duplicate tasks or executions. Identical requests return the original result; different payloads with the same requestId are rejected. revision-conflict preserves edit drafts and asks for reload rather than overwriting.

Model tools create plans, query pages, inspect details and request execution. Users own acceptance; the model cannot promote review to done itself. Queries respect identity/storage scope. Model child selection uses real IDs. New model-visible task inputs and tool results must be reconstructable from Session records and covered by snapshots.

Operation names are design conventions and may be renamed consistently across consumers and documentation. Clients cannot depend on operations before they exist.

<a id="section-12"></a>

## Storage queries and migration

Task/Execution/Activity writes remain owned by storage-domain. The plugin must not bypass domain memory snapshots to modify SQLite files. Indexed querying and cross-table transactions have not been established for the current domain API, so both require capability confirmation before implementation. A SQLite backend alone is not a business query API.

An initial Host may maintain a rebuildable query-field index over existing domain snapshots and paginate server-side, updating the index after durable writes. It is not another authoritative task store. This does not remove startup memory costs from loading domain records and must be measured at target scale. If inadequate, the same iteration adds storage query service definitions, providers and consumers rather than direct SQL against private SQLite tables.

Plan creation and multi-task state changes use cross-record transactions committing tasks, execution references and activity together. If domain lacks transactions, the same iteration first supplies transaction definitions, a SQLite provider, domain consumers and memory publication after durable completion. Failures publish no partial memory state and restart reveals no partial plans. Sequential writes with best-effort rollback do not satisfy this design.

External Session startup cannot run inside a database transaction. Persist a requestId-bound execution intent and claim startup ownership, create/start the Session, then persist its confirmed sessionId. A crash between stages remains startup-unconfirmed rather than automatically creating another Session. Recovery compares recorded identity with actual Sessions and exposes action needed when uncertain. Cancellation and startup coordinate through the same task revision and claim state.

Migration preserves existing task IDs, states, projects, runs and the coordinator singleton. Old tasks become root leaves and old runs become executions. Missing historical completion/acceptance times remain unknown rather than fabricated from updatedAt. Migration activity records the migration, not invented previous transitions.

Follow domain versioning and persistence-type rules for adjacent migration, idempotent validation, failure recovery and upgrade guidance. SQLite schema versions increase monotonically. Do not overwrite released records/migrations, and state that older builds cannot read new data rather than promising downgrade support. Stop the owning Host and back up tasks/Sessions before migration. Failure never clears the database and Session logs remain unchanged.

Update the [persistence-type review acknowledgements](../../cookbook/reviewing-persistence-type-changes.md) during implementation. This document changes neither domain schemas nor actual migrations.

<a id="section-13"></a>

## Refresh, responsive layout and accessibility

Poll only summaries/details for the visible view using pollIntervalMs. Pause in the background and refresh on activation. Debounce search, cancel superseded requests and reject stale responses after coordinator, view or query changes. Shared skeletons serve initial loads; refresh retains content. Background polling does not emit repeated success toasts.

Filters, page size, selected task, expanded items and scroll position are local presentation preferences scoped to assistant storage identity. Expired query IDs are not durable business state. Different DSH_HOME stores do not share preferences. Update notices never steal focus, expand collapsed sections or change pages; changes during editing expose revision conflicts.

Narrow sidebars use single-column cards with wrapping project/time metadata. Wider sidebars add summary/time columns and detail grids. Container width, not window width, controls adaptation. Pagination can wrap into two rows; title and back navigation remain visible. One primary scroll area avoids nested permanent scrolling; long content/history expands on demand.

Reuse shared tabs, buttons, tooltips, toasts, menus, scroll styles and theme/typography tokens. New weights do not exceed 500. State uses words/icons as well as color; reduced-motion settings disable pulse. Collapse controls expose aria-expanded, pagination supports keyboards and detail navigation restores focus. Verify Chinese/English and light/dark themes.

A 404 retains the profile-plugin error and recovery action. Authorization/network failures do not replace the coordinator or reset tasks. Refresh failures retain last successful content with its update time. Local failures never obscure the entire panel.

<a id="section-14"></a>

## Implementation order and ownership

Finalize persistence, atomic writes and migration before queries, child lifecycle and model tools, then build UI with Host/Client consumers kept consistent. Stage 1 covers storage capability, Task/Execution/Activity, migration and states. Stage 2 covers atomic plans, dependencies, acceptance, idempotency and conflicts. Stage 3 covers snapshots, paging, history and indexes. Stage 4 covers overview, details, lists, history and Session navigation. Stage 5 covers scale tests, both applications and migration material.

| Owner | Main work |
|---|---|
| Plugin storage.js | Versioned records, authoritative write unit and migration integration. |
| Plugin runtime.js | Child lifecycle, dependency validation, atomic plans, acceptance, queries and model tools. |
| Plugin index.js / api.js | Authenticated dispatch, error codes, paginated response validation and cancellation. |
| Plugin client.jsx | Overview, TaskList, TaskDetail, ChildList, HistoryList and view state; split growing TaskPanel responsibilities. |
| Plugin css.js / locales.js | Shared styles and complete bilingual copy. |
| Storage service, only if capabilities are missing | Complete transaction/query definitions, providers, consumers and documentation. |
| Plugin README, feature list and upgrade guide | Shipped behavior, migration and itemized verification status. |

Update existing feature entries without equating design approval with implementation. Regress fixed directories, unique coordinator identity, history recovery, project execution and shared sidebar registration. Visual delivery alone does not satisfy child-task and paging scope.

<a id="section-15"></a>

## Acceptance matrix and performance targets

| Acceptance case | Expected result |
|---|---|
| One parent with three ordered dependent children. | All visible immediately; successors explain blocking before prerequisite acceptance. |
| Required child fails while another runs. | Parent exposes action needed plus active count and Session entry. |
| Leaf retries three times. | One child retains three attempts and observed start/end times. |
| All children accepted, parent not accepted. | Parent remains review until explicit overall acceptance. |
| Cancellation, stop failure and prerequisite reopening. | No false completion; dependency and acceptance validity follow defined rules. |
| Invalid edges, cycles, cross-parent links and revision conflicts. | Host rejects without partial plans, lost edits or duplicate execution. |
| 21, 40 and 41 roots at page size 20. | Correct boundaries/counts without counting children as roots. |
| Inserts/updates while paging one snapshot. | Stable membership/order; refresh notices rather than page jumps. |
| Query expiry, Host restart and identity changes. | Explicit rejection, retained filters and renewed queries without identity leaks. |
| Search matches a child outside loaded pages. | One parent result with match summary and direct child navigation. |
| History ranges, deleted projects and legacy migration. | Complete search scope, explicit unknown times and retained records. |
| Query errors, repeated clicks, navigation and recovery. | Retained content, idempotency, stale-response rejection and intact drafts/identity. |
| Narrow/wide sidebar, keyboard, locales and themes. | Reachable controls, no overflow, correct focus and collapse preferences. |

Suggested scale fixtures contain 10,000 parents, five children each and three attempts per child, plus one parent with 1,000 children. Fix host, seed and cold/warm conditions before measuring. Proposed targets, not current promises: warm first-page p95 at most 300 ms, child expansion p95 at most 200 ms, ordinary 20-item summaries at most 128 KiB, and rendered root nodes bounded by page size. Bound long summaries with detail access without truncating required state.

Measure cold-start memory, index build, keyword search and snapshot quotas. Existing domain hydration may dominate memory; adding server pagination alone cannot claim to fix it. Confirm thresholds against reproducible measurements and record actual results.

Cover Host lifecycle/query, migration, client pagination/focus/errors, model-tool keyless Session snapshots and real Web/Desktop flows. Use pnpm run build:local for coordinated dependency, plugin and application artifacts, saving output as described in [local builds](../../cookbook/local-builds.md). Compilation never substitutes for feature acceptance.

<a id="section-16"></a>

## Dev note and pre-implementation decisions

This document implements none of the proposed behavior and changes no user data. Before implementation, inspect current storage-domain code to implement required atomic commits and verify scale-query support, confirm explicit parent re-acceptance as product behavior and size query-snapshot quotas from measurements. Apart from these checks, parent-child relations, accepted-prerequisite defaults, pagination and navigation are implementation inputs.

Calendar, priorities, due dates, recurring tasks, cross-project children and dependency diagrams can extend the design separately. They do not contribute fabricated data to this iteration. Rule changes update this design and the feature list before implementation and verification.
