# Feature list

English | [中文](features.zh.md)

Updated: 2026-10-11. This list records recent features, their purpose, and available verification; a successful build does not establish live-engine or UI acceptance.

## Personal Assistant plugin: project dashboard

`dsh-personal-assistant` provides a read-only project dashboard. See the [plugin documentation](../plugins/dsh-personal-assistant/README.md) and the [upgrade guide for removed features](upgrade-guide/v0.2.0-rc.2/personal-assistant-dashboard/guide.md).

| Feature | Purpose | Status |
|---|---|---|
| Usage dashboard replaces the assistant workspace | The sidebar opens a project dashboard. Task, Todo, personal-knowledge, and assistant-chat features, resident coordinator Session creation and management, and the former model tools, API, settings, and storage routing are removed. Existing Session logs and database files remain; the dashboard neither reads nor modifies the task database. | Former features retired and implementations removed; coordinated build passed |
| Today and last-seven-days summary | Shows active projects, active Sessions, newly created Sessions, and token totals in the browser timezone. Today's chart groups by hour; the seven-day chart groups by date. The last seven days include today and the preceding six days. | Implemented; build passed, user confirmed dashboard loading works |
| Project and Session usage details | Assigns Sessions through Workspace membership and matching working directories, groups unmatched Sessions under the unassigned project, and displays project usage and recently active Session details. The UI shows at most 30 Sessions. | Implemented; complete totals reconciliation pending |
| Native, Codex, and Claude token accounting | Adds provider-reported input, output, cache-read, and cache-write usage from Session logs. Adds only the uncovered remainder of per-message totals and Codex/Claude cumulative engine totals, and excludes fork-inherited events to avoid duplicate counts. | Implemented; coordinated build passed, live usage reconciliation across all three engines pending |
| Compact 万/亿 counts | Chinese large counts retain two decimal places, such as `1.00万` and `1.00亿`; totals, charts, and details use the same formatter. | Complete: number formatting verified and build passed |
| Caching, refresh, and loading feedback | Reads Sessions through `sessionQuery` and projects through `workspaceRegistry`. Snapshots are cached for one minute; manual refresh recalculates them. Loading failures show a diagnostic code and retry action; unreadable Sessions produce an incomplete-totals notice. Historical-log caching reduces repeated parsing, but the first calculation still scans history. | Implemented; user confirmed loading works, large-history timing measurements pending |

An active Session contains a user or assistant message during the reporting period; it need not have a running background Agent. Totals cover only readable application Session logs: missing provider reports, external engine conversations that have not been imported, and unreadable Sessions cannot be recovered by the dashboard. Cumulative engine remainders are assigned to their report time.

## Session archival and project history

| Feature | Purpose | Status |
|---|---|---|
| Optional summary during archival | The summary checkbox is unchecked by default. Ordinary archival sends no model request; project Sessions can opt into a summary. Existing running work still requires stop confirmation. | Implemented; archive options and ordinary archival have recorded-session replay verification |
| Original engine and Session write the changelog directly | Submits one summary follow-up through the original native, Codex, or Claude engine, with the absolute owning project-root `CHANGELOG.md` path. The engine uses its own tools to preserve existing content and append a short entry with a timestamp and Session id. The prompt, tool operations, reply, and token usage remain in the original Session log. | Implemented; typecheck and coordinated build passed, live-engine validation pending |
| Silent background summary | Confirmation closes the dialog immediately. Summary generation, verification, and archival run in the background without a success notice. Failure shows a notification and leaves the Session unarchived; engine file changes are retained. | Implemented; build passed, interaction acceptance pending |
| Protected archive commit after summary completion | Waits for the summary turn to become idle, then flushes, verifies the entry through read-only access, and commits archival while holding Agent maintenance. New turns are deferred during this work; queued messages reject archival, and other provider activity still requires stop confirmation. Concurrent requests for one Session share one operation. | Implemented; typecheck and coordinated build passed on 2026-10-11, live archival acceptance pending |

## Other recent UI changes

| Feature | Purpose | Status |
|---|---|---|
| Project names in Recents and conversation headers | Recents shows `project/session title`; conversation headers include the owning project. Former Personal Assistant execution Sessions qualify normally, with the `· 个人助理` suffix removed for display. Blank, archived, subagent, and catalog-excluded Sessions remain absent from Recents. | Implemented; coordinated build passed, UI acceptance pending |
| Hover preview of a collapsed Desktop sidebar | On macOS/Windows, dwelling at the left edge previews the existing sidebar while preserving conversation width; pressing the sidebar toggle opens it permanently. | Implemented; build passed, desktop interaction acceptance pending |
| Team flow graph and workflow plan cards | Task flow graphs support dependency selection, zoom, pan, and fullscreen. Conversation `team_workflow_create` calls show read-only creation-plan cards, with creation snapshots separate from live execution statuses. | Implemented; coordinated build passed, latest canvas and card interaction acceptance pending |
| Center terminal plugin removal | Removes the `dsh-center-terminal` implementation and installation entry. | Removed; coordinated build passed, installation records in old external profiles require separate inspection |
