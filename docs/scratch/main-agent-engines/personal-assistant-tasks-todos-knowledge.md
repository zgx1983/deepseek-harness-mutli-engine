# Personal assistant tasks, Todo and long-term knowledge design

English | [中文](personal-assistant-tasks-todos-knowledge.zh.md)

## Summary

The personal assistant uses a full conversation to manage task execution, capture Todos and save personal ideas. Its right workspace provides Tasks, Todo and Knowledge entries. Tasks and Todos use structured storage owned by the personal assistant, independent of Agent Team and Session logs; Markdown files own knowledge content. Each task execution links to a separate Session that users can enter to inspect work, report progress and confirm results.

## Table of contents

- [Scope and current state](#scope)
- [Layout and prototype](#layout)
- [Task creation and execution configuration](#tasks)
- [Execution Sessions and status reporting](#sessions)
- [Todo and task conversion](#todos)
- [Personal ideas and Markdown knowledge](#knowledge)
- [Persistence and consistency](#storage)
- [Tool and interface responsibilities](#interfaces)
- [Implementation order and acceptance](#acceptance)

<a id="scope"></a>
## Scope and current state

Confirmed on 2026-10-07, this proposal defines intended features and interactions rather than implemented backend behavior. The plugin already has a fixed Native coordinator Session, a fixed working directory, parent/child tasks, dependencies, project assignment, execution records and acceptance. Task startup does not yet explicitly pass engine and model choices, and execution Session references remain read-only records. Todo, long-term Markdown knowledge and execution-Session task tools need to be added. Actual status belongs to the [feature list](../../../worktree-feature-list.md) and [plugin README](../../../plugins/dsh-personal-assistant/README.md).

This scope includes execution configuration, Session navigation, progress and result reporting, user acceptance, Todo conversion and long-term knowledge storage and retrieval. It is independent of Agent Team runtime and does not require the coordinator Session to retain its original context. Semantic search, automatic reminders, automatic weekly summaries, unlimited task nesting and a full file editor are outside the initial delivery requirements.

<a id="layout"></a>
## Layout and prototype

Keep left navigation, a full middle conversation and the shared right sidebar. Do not add a Current focus or task-summary strip above the conversation. The right workspace has an assistant title, an add button appropriate to the current view, and Tasks / Todo / Knowledge entries. Task counts show unfinished parent tasks, Todo counts show unfinished items, and knowledge counts show valid documents.

[Open the interactive HTML prototype](personal-assistant-sidebar-prototype.html). It is a standalone file with no external runtime dependencies and can be opened directly in a browser. Its top controls adjust sidebar width from 320 to 560 px, switch light/dark themes and reset examples. Data and actions are demonstrations confined to the current page and reset on reload; Markdown downloads contain sample content. Script syntax and rendering smokes were checked; visual acceptance in a real browser remains required.

```text
个人助理                     ＋ 新建
[任务] [Todo] [知识]

任务：概览 / 全部任务 / 历史
      正在运行 → 等待确认 → 待办 → 历史
Todo：未完成 / 全部 / 已完成、已转任务
知识：全部 / 想法 / 笔记
```

Lists, details, filters and pagination switch within the same sidebar. Each entry retains its conditions, page and scroll position independently; returning from details restores the source list. Task groups collapse, show full counts and bounded items, and provide full-list access when more exist. Search and long lists paginate rather than filling the overview with all history. The shared frame adapts sidebar presentation to narrow windows; the prototype shows only the workspace on narrow screens for review.

Ask about this item inserts content with a stable reference into the composer draft for the user to send; the UI never sends silently. Task states use text as well as visual indicators. Failure, dependency blocking and missing configuration must not rely on color alone. Themes, keyboard behavior, focus and shared-sidebar conventions reuse existing client components.

<a id="tasks"></a>
## Task creation and execution configuration

Users create tasks through the assistant conversation or the right-side form and can specify project, engine, provider and model. For example: create a task in the harness project using Claude and DeepSeek Flash to check permission configuration and submit a repair summary. Tasks save title, goal, acceptance criteria, project, execution configuration, parent/child relations, dependencies and source references; a source can be a conversation, Todo or knowledge document.

Create task saves pending work; create and start checks conditions after creation and then starts execution. Saving permits incomplete project or execution configuration and displays concrete missing fields. Startup requires all mandatory choices to be resolved, the project and engine to be available, dependencies to be satisfied and model settings to be compatible. Container parents start only ready children and never receive an additional parent execution Session.

Provide the coordinator model with real project, engine, provider and model catalogs. The model interprets shorthand and selects exact identifiers; the Host checks existence, valid references and engine compatibility without replacing choices through local fuzzy matching. When several candidates are reasonable, the assistant presents them and clarifies with the user. Unspecified choices use configurable personal defaults shown explicitly before startup. Failures identify missing fields or incompatibility rather than falling back to another model.

Parents provide default execution settings; children may explicitly override engine, provider and model. Initial project assignment retains the existing rules within one parent. Each execution stores a snapshot of its actual configuration. Changing task defaults affects only future executions, leaving existing Sessions and historical snapshots unchanged; changing a previously executed task's project follows the existing project-locking rules.

<a id="sessions"></a>
## Execution Sessions and status reporting

Each execution attempt links to an exact Session, with Task–Execution–Session associations stored durably. Running task cards offer Enter conversation; ended tasks open the latest attempt, and details allow navigation to each attempt. A parent card opens its active child's Session, offering an explicit choice when multiple children are active; each child also has its own entry. Unstarted tasks say no Session has been created. Unavailable Sessions retain their execution records and an explanation.

Before its first model request, an execution Session receives explicit ownership context: project identifier and name, actual working directory, task identifier, goal, acceptance criteria, current state, parent and dependencies, plus the Execution identifier and actual execution configuration. The Host derives this information from durable associations rather than relying on the model to remember startup prose. After reopening, process restart or compaction, task-query tools retrieve current state again. Model-visible context and query results enter reconstructable Session records.

Execution details show engine, provider, model, start/end times, state, progress, results and failure reasons. Unknown times are not fabricated. Parent details summarize child dependencies and states, and execution records name the child to avoid presenting child attempts as separate parent execution.

Use shared Session navigation rather than nesting another conversation implementation. Execution conversations show the linked task, task-detail access and Return to assistant. Returning restores task details, source view and scroll position while retaining the assistant draft. Navigation itself never starts work or sends a message.

Execution models can query their linked task, report progress, describe blocking and submit results. Native uses framework tools; Claude and Codex receive equivalent operations through their supported tool or MCP integration. The Host limits scope using trusted Session–Execution associations, not model-supplied taskId, executionId or actor fields alone. Historical execution Sessions can inspect records; stale attempts cannot continue changing the current execution. Re-execution creates a new Execution and Session without overwriting old records.

```text
待执行 → 执行中 → 等待确认 → 已完成
             ↘ 需要处理 → 重试
```

Explicit model result submission moves the task to awaiting confirmation. A reply ending, a process exiting normally or text claiming completion cannot by itself establish business completion. Failure, stopping and recovery retain existing lifecycle rules. Results save summaries and Host-validated Session or artifact references; users can inspect the full execution conversation first.

Users can confirm through the sidebar or explicitly request acceptance in the assistant or execution conversation. Conversational confirmation uses a trusted user-action path bound to the exact task, execution and revision; a model cannot claim authorization by supplying actor=user. Resolve ambiguous task references first and recheck state and revision on confirmation. Child acceptance lets the Host recompute dependencies and the parent aggregate. A parent cannot finish with unfinished required children, and successors do not start automatically by default.

An explicit user statement in the current execution conversation, such as this task is complete or accept the result and mark it done, instructs completion of that conversation's bound task without requiring the task ID again. The model interprets the intent and requests completion; the Host resolves the task and execution through the trusted current-Session association, checks the original user message, state and revision, durably writes done, completion/acceptance times and the user-action record, then returns the task name and update result. Discussion, quoted text, conditional statements and model-generated completion claims do not constitute user acceptance. Repeated requests return the existing completed result without duplicate acceptance records. Unresolved references, revision conflicts or unmet conditions receive explicit explanations rather than a success claim.

Explicit user acceptance can complete the current task without a preceding model completion report. If execution remains active, it must first stop or settle at a controlled execution-end point; complete the task only after confirming execution is no longer running, and never mark done after a failed stop. A child Session completes only its child, with the Host aggregating the parent; unfinished required children prevent parent completion. When a new execution supersedes an old attempt, the old Session can query and direct users to the current Session but cannot apply completion instructions to the new attempt.

State changes write to one authoritative task store shared by sidebar and Sessions. Clients refresh or subscribe to projections; they never maintain separate task state inferred from chat text.

<a id="todos"></a>
## Todo and task conversion

Todos capture intended actions before execution is ready, without immediately requiring a project, engine, model or acceptance criteria. Users can ask the assistant to record a Todo to organize permission documentation next week or add one in the sidebar. Records include content, description, tags, priority, optional date, source conversation, knowledge references and linked tasks.

Todo provides unfinished, all, and completed/converted views, with creation, editing, search, pagination, completion and reopening. States are unfinished, completed, converted to task and cancelled. Conversion does not mean the work is finished. Dates support display, sorting and filtering; without reminder integration, the product must not promise proactive notifications.

Every unfinished Todo offers Convert to task, also available through assistant conversation. Conversion supplies project, goal and execution settings and can save pending work or explicitly create and start. Task creation, Todo state changes and associations commit in one transaction; duplicate clicks or retries return the same conversion. Original Todo content, sources and history remain, with access to the linked task and its current state.

Multiple Todos can merge into one task while retaining each source association. Initially a Todo converts once by default; another decomposition or task creation requires an explicit action rather than treating a retry as a new plan. When the linked task is cancelled, the user decides whether to reopen the Todo; the system does not automatically reopen, delete or erase association history.

<a id="knowledge"></a>
## Personal ideas and Markdown knowledge

Knowledge distinguishes ideas from notes: ideas may be rough, while notes contain organized experience and conclusions. Persist content when the user explicitly asks to record or save it. Model-derived lessons from execution appear as save suggestions instead of automatically overwriting knowledge.

The default knowledge directory is `$DSH_HOME/personal-assistant/knowledge`, configurable to another location. Ideas live in ideas and organized notes in notes. Models and other tools can directly search and read these Markdown files.

```text
knowledge/
├── ideas/
│   └── 2026-10-07-weekly-summary.md
└── notes/
    └── permission-mapping.md
```

Documents have stable identifiers, titles, creation/update times, tags, project references and Task/Todo references. Content retains original expression and later organization. Paths may change; associations use stable identifiers. Missing metadata, duplicate IDs or invalid frontmatter produce explicit errors rather than silently dropping content. External files can receive missing metadata through explicit import or repair.

```markdown
---
id: idea-稳定标识
title: 个人助理每周总结
created: 2026-10-07
updated: 2026-10-07
tags: [个人助理, 周报]
projects: []
relatedTodos: []
relatedTasks: []
---

# 个人助理每周总结

## 原始想法

根据本周任务执行情况，整理完成事项、未完成原因和下周计划。

## 补充与整理

后续补充的内容，以及确认保留的整理结果。
```

Knowledge supports title, content, tag and project search, reading rendered content and Markdown source, adding or extending documents, downloading, generating Todos, creating tasks and discussing content in the conversation. Updates first identify the intended record and show candidates when ambiguous. Model organization preserves user originals, revisions retain backups, and similar ideas are never merged silently.

Markdown is the sole authoritative content. Search indexes and sidebar summaries may be cached but must rebuild from files. Clients and retrieval detect direct user edits; writes check file versions and reload/resolve conflicts rather than overwriting external edits. Knowledge reads and writes remain within the configured directory, rejecting traversal and links that escape it.

Long-term retention does not load all knowledge every turn. Initial retrieval uses text, tags and projects to select a small relevant set and attaches navigable knowledge references to answers; semantic indexing can follow later. Retrieved text is reference material rather than system instructions. Model-visible content and retrieval results must be reconstructable from Session records, not just mutable file paths.

Knowledge can produce Todos or tasks while retaining document associations. Structured storage and the filesystem do not share a database transaction: cross-medium associations require durable operation intents, idempotent retries and recovery reconciliation. On failure, keep the source file and expose incomplete associations rather than claiming an atomic write to both media.

<a id="storage"></a>
## Persistence and consistency

Tasks and Todos belong to personal-assistant storage, do not reuse Agent Team's task board and do not depend on the coordinator conversation for recovery. They may share the assistant SQLite database but use separate tables and access interfaces so Todo conversion can use a database transaction. Task, execution, result, activity and Todo tables own distinct records; the database keeps only rebuildable indexes and associations for knowledge, not a second authoritative content copy.

Task and Todo writes carry revision and request-deduplication identifiers. Conflicts do not overwrite another client's edits. The Host checks transitions, while models request operations. Failed transactions publish no partial plan, and repeated conversions create no second task. Execution startup saves its intent first and then the Session association after creation. Unconfirmed crash-time intents are reconciled into recoverable states rather than blindly creating another Session.

Markdown writes use same-directory temporary files and atomic replacement, retain revision backups, and manage renames and stable-ID indexes. Multiple Hosts and external edits need version checks and serialized writes; client caches are never authoritative. Backups cover the assistant database, knowledge directory and referenced Session logs together.

Assistant compaction, recovery or replacement never deletes tasks, Todos or knowledge. Unavailable execution Sessions do not delete task records, and missing knowledge files do not erase association history. New persisted fields follow repository declarations, type-change acknowledgements and migration rules. Committed predecessor generations remain intact; use explicit successors or supported monotonic schema migrations without promising downgrade support.

<a id="interfaces"></a>
## Tool and interface responsibilities

These are proposed operation groups, not a current API inventory. UI, coordinator models and execution models share Host business capabilities with different scopes.

| Consumer | Capabilities | Restrictions |
|---|---|---|
| Assistant coordinator Session | Query catalogs, create/update plans, request execution, manage Todos, retrieve/save knowledge | Cannot replace user acceptance; Host validates exact identifiers selected by the model |
| Current execution Session | Query its task and report progress, blocking and results | Bound current execution only; cannot update unrelated tasks or stale attempts |
| User UI and trusted conversational actions | Configure tasks, navigate Sessions, accept results, cancel/recover, edit Todos and knowledge | Consistent state, revision and identity checks; navigation never triggers execution |
| Query and synchronization services | Pagination, search, details, execution history and change projections | Structured records or Markdown are authoritative; caches rebuild |

Validate model-tool input, HTTP/RPC input, persisted reads and file metadata at their external entry points. Record tool results, task context and retrieved knowledge according to the model-visible-implies-logged rule. Claude/Codex tool delivery, engine readiness and first-task-message submission use their official integration paths. Startup failure must not leave a task falsely appearing to run.

<a id="acceptance"></a>
## Implementation order and acceptance

Phase one completes the task loop: project/engine/model configuration, execution snapshots, Session navigation, current-execution tools, progress/result reporting and user acceptance in UI or conversation. Phase two adds Todo records, sidebar access, conversion and source associations. Phase three adds the Markdown directory, revisions, search, external-edit detection and on-demand retrieval. Each phase updates consumers, README, feature list and applicable migration documentation, and marks completion only after verification.

| Acceptance area | Required observation |
|---|---|
| Configuration resolution | Model resolves shorthand against real catalogs; ambiguity can be clarified; missing/incompatible choices refuse startup |
| Session access | Current, historical and child entries target exact Sessions; absent/unavailable cases are clear; returning restores the assistant view |
| Three engines | Native, Claude and Codex receive scoped task tools with correct startup/submission ordering |
| Status reporting | Reply ending never completes work automatically; results await confirmation; user completion requests in the current Session update the bound task with traceable source messages and acceptance records; retries are idempotent; stale attempts cannot update current work |
| Ownership context | Project, working directory, task and execution identity are available before the first model request; restart, reopening and compaction permit querying current state; task context reconstructs from Session logs |
| Parents and dependencies | Unfinished required children prevent parent completion; acceptance recalculates dependencies; no duplicate parent execution Session |
| Todo conversion | Retries create no duplicates; failures leave no partial database association; reopening after cancellation requires user choice |
| Markdown | Originals, revisions and stable references survive; external edits are detected; conflicts do not overwrite; rebuilt indexes support retrieval |
| Independent persistence | Restart, coordinator replacement and compaction retain data; missing Sessions do not delete tasks or knowledge |
| UI | Three entries, search, pagination, collapse and empty states work; drafts and return positions remain stable; narrow width, both themes and keyboard work |

The prototype illustrates primary interactions but does not replace real-profile runtime, cross-client consistency, engine integration, file-conflict or restart-recovery acceptance. Task scale, search latency and performance with many Markdown files require separate measurements using real data.
