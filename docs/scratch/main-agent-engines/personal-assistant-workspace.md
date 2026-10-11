# Personal assistant task workspace and fixed Session design

English | [中文](personal-assistant-workspace.zh.md)

Superseded on 2026-10-10. This historical design records the former task workspace and global assistant Session; the plugin now provides a project and token-usage dashboard. See the [current plugin README](../../../plugins/dsh-personal-assistant/README.md).

## Summary

The assistant page shows three columns: the full conversation and model replies in the main column, and the assistant tab of the shared right Sidebar hosting the task panel with status, filters, and acceptance actions; the column opens when the assistant page activates. The assistant has a fixed working directory and a Session reused across projects. Task execution uses separate project Sessions with full details available on demand.

## Table of Contents

[Current implementation](#current) · [Page and interaction](#layout) · [Reply display](#replies) · [Fixed directory and Session](#identity) · [Data updates](#updates) · [Scope](#scope) · [Acceptance](#acceptance)

<a id="current"></a>

## Current implementation and starting point

This section describes the 2026-10-04 design baseline and is no longer current. The task UI, model tools, persistent assistant Session, and working-directory settings described here have been removed; the [current plugin README](../../../plugins/dsh-personal-assistant/README.md) describes the dashboard.

<a id="layout"></a>

## Page and interaction

Keep the Personal assistant title and service status at the top. Tasks occupy the upper region and conversation the lower region, separated by a draggable divider. Initially allocate roughly seventy percent to tasks and thirty percent to conversation. The ratio is a configurable presentation preference rather than a business rule. Small windows respect usable minimum heights, with independent scrolling and a visible composer.

The task region contains status counts, search and filters, then the task list. Counts cover pending, running, review, attention, and done, with review and attention prominent. Show unfinished tasks by default; filters expose completed and cancelled tasks while total counts remain visible. Filter by project and status and search titles and descriptions.

Each task shows title, project, status, last update, and current execution summary. Use compact rows on wide screens and cards on narrow screens, with long descriptions in details. Persisted task records determine status; completion text in a model reply cannot change it.

Selecting a task opens inline details with description, execution history, summary, errors, and supported actions. Avoid a permanently occupied sidebar; open the execution project Session or a shared detail sidebar when full execution history is needed. Preserve task selection, filters, and region ratio when returning.

Expose creation, title and description editing, project selection, start, stop, result acceptance, cancellation, and reopening according to Host capabilities. Distinguish stopping execution from cancelling a task. The Host validates availability; disable duplicate submissions while pending and show failures beside the affected task.

Users describe tasks in conversation or use list actions. Successful conversational operations link their structured results to tasks, refresh the list, and briefly highlight affected items. An explicit Ask about this task action includes its ID in the logged message; client selection must not become hidden, unrecorded model input.

<a id="replies"></a>

## Compact conversation and reply display

Initially show the latest user request, reply preview, and composer. View full conversation exposes older history. Replies use a bounded preview with access to full content; tool logs initially fold. Use deterministic text previews and existing structured result cards without additional model summarization calls that could add cost or omit commitments.

Task change cards show actual tool results such as creation, start, and status updates, linking to tasks. Ordinary replies retain previews. Expand long text, code, and file content on demand; keep full messages and logs. Streaming exposes recent content without forcing users reading history back to the bottom.

Keep authorization, questions, errors, recovery notices, stop controls, and acceptance requests visible outside ordinary folding rules. Allow conversation expansion to fill the main area and return without losing drafts, scroll, or focus. Reuse model controls while keeping the assistant engine Native.

<a id="identity"></a>

## Fixed working directory and global Session

Global means one coordinatorSessionId per assistant task store within the same DSH_HOME, reused across projects, navigation, restart, and Web/Desktop sharing that home. Different DSH_HOME values or explicit dataDirectory values remain independent; no implicit account-wide or cross-host Session is introduced.

Add optional assistantWorkingDirectory configuration. Default to workspace under the resolved assistant dataDirectory, usually <DSH_HOME>/personal-assistant/workspace. The Host creates the dedicated default directory. Explicit configuration must resolve to a usable absolute directory; failures must be reported without falling back to the launcher cwd.

Create the assistant Session with explicit engineId=native and fixed cwd, without the selected project workspaceId. Hide workspace switching and offer readonly directory information. Coordination uses this persistent Session. Task execution still creates a separate project Session from task.workspaceId and records each execution Session ID.

The assistant directory contains local coordination files and context, without presenting task JSON or account configuration as ordinary work files. It is not a security sandbox. Project changes should run in project execution Sessions; the model may query registered projects and select a task project. Changing assistant cwd must not alter existing execution Session directories.

One Host operation owns lookup, creation, and recovery under the existing cross-process file lock. Remove client-side creation triggered by catalog absence: retain the ID and retry loading when temporarily invisible. Network or authorization failures cannot replace the global Session. Concurrent clients must receive the same ID.

Reuse an existing coordinator when its cwd matches. If it differs, do not alter historical identity: perform a one-time explicit migration under the lock, create the new coordinator at the target directory, retain the old reference and reason, and preserve logs. Task and execution records remain associated. The new Session reads tasks through existing tools without claiming inherited conversation memory. Explain replacement and expose the old conversation.

After changing assistantWorkingDirectory, restart the configuration and apply the replacement rule with a notice before normal use. Hosts sharing storage but resolving different directories must report a conflict rather than repeatedly replace Sessions. Corrupt-history recovery uses the fixed cwd and retains the once-per-client-activation automatic recovery guard. An inaccessible directory blocks coordinator startup with a recovery path; it does not erase data.

Store the confirmed directory identity and replacement reason; new reasons must not reuse corrupt-history. During implementation, inspect strict stateSchema compatibility and determine versioned migration and upgrade-guide requirements under persistence rules. Never overwrite historical Session logs or unconditionally reset tasks.v1.json.

<a id="updates"></a>

## Data refresh and multi-client operations

The task panel reads dashboardSnapshot on activation and polls using pollIntervalMs while visible. Refresh immediately after successful actions, pause in the background, and resume on activation. Cancel stale requests and reject old coordinator epochs after replacement. Polling failures must not clear the previous list.

Web/Desktop sharing task files and Sessions reuse Host file locks and state validation. Prompts, queues, and interruption use existing Session scheduling and show the shared assistant activity without introducing a second coordinator. Stopping execution does not mean user acceptance.

<a id="scope"></a>

## Scope and ownership

Most work belongs to the personal-assistant plugin: task list, details, refreshing, directory configuration, Host Session lifecycle, and recovery. Reuse shared vertical layout and conversation components. If conversation.shell lacks compact presentation, add an explicit host option while preserving defaults; avoid CSS hiding critical controls or copying message rendering.

Implement fixed-directory coordinator creation first, then the task page and refreshing, compact replies and task navigation, and recovery migration with multi-client acceptance. Retain existing assistant task states and project execution. Agent Team graph and folding have a [separate design](team-panel-flow.md).

<a id="acceptance"></a>

## Acceptance and feature status

Layout acceptance covers window widths, resizing, filtering, prominent review tasks, full reply expansion, draft and focus retention, visible authorization and errors, locales, and themes. Refresh operations from successful Host results. Execution ends in review; only user acceptance produces done.

Session acceptance covers different launcher directories, project changes, restarts, concurrent Web/Desktop access to one ID, inaccessible paths, configuration conflicts, one-time directory migration, and corrupt-history recovery. Creation and recovery must pass the same fixed cwd while task execution uses its project directory.

Implementation adds lifecycle tests, client behavior tests, and user-visible output snapshots. Current work is source inspection and design only. The feature list records Design complete, implementation pending; update the same entry after validation.

## Dev Note

The working-directory configuration is `assistantWorkingDirectory`, and the layout shipped as three columns. Task storage later moved to the `personal_assistant` storage domain (routed to SQLite by the bundle), retiring the version-1 JSON file plan; the `coordinatorDirectory` identity and the `working-directory-moved` replacement reason live in the domain singleton. Implementation and Host lifecycle tests are complete; multi-client and migration acceptance on a real profile remains.
