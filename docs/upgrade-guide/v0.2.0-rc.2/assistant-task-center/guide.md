---
kind: upgrade-guide
description: "The personal assistant upgrades to hierarchical tasks with dependencies and acceptance, and task data migrates into the version-named v2 storage domain."
---

# Personal-assistant hierarchical task workspace and the v2 storage

English | [中文](guide.zh.md)

## Change

In v0.2.0-rc.2, `dsh-personal-assistant` stored every task as one row of the single-level `tasks` table in the `personal_assistant` storage domain (v1), with executions inside the task's `runs` array; POST `/api/personal-assistant/tasks` accepted only `dashboardSnapshot`, the coordinator operations, `create`, `start`, `update`, and `dashboardStopWorkItem`.

The plugin now stores tasks in the version-named successor domain `personal_assistant_v2`: the `tasks`, `executions`, `results`, and `activities` tables plus the coordinator singleton. The task model is strictly two-level — a parent container aggregates child statuses and a leaf task executes many times, each run leaving an Execution record; children support `dependsOn` within the same parent and a successor unlocks only after its predecessor is accepted; a parent needs the user's overall acceptance. The `update` operation is removed; status changes move to `startTask`, `stopTask`, `acceptTask`, `reopenTask`, and `cancelTask`, model decomposition and batch edits use `createPlan` and `updatePlan`, and queries use `overview`, `listTasks`, `getTask`, `listChildren`, `listExecutions`, `listActivity`, and `listResults`. Every list paginates server-side with query snapshots (`queryId`, `changedSinceQuery`, `query-expired`). Error responses carry stable codes, and writes check `expectedRevision` and `requestId`. The right-side task panel upgrades to the overview / all-tasks / history views plus the task detail. Cross-record writes commit through the storage domain's new atomic batch transaction (`KvUnit.applyBatch`, `Domain.transact`).

## Migration

1. Stop the Host process using this assistant storage and back up `$DSH_HOME/storages/personal-assistant.db`.
2. Restart the running profile so the Host routes, storage routing, and client bundle load together. The bundle patch now carries `routes: { personal_assistant: sqlite, personal_assistant_v2: sqlite }`; compositions that override the `storage-domain` row themselves must include the same two routes.
3. The first start runs the one-time migration automatically: every v1 task becomes a childless top-level leaf task, `runs` map to Execution records, and the coordinator singleton is preserved; tasks without a real acceptance or completion time never gain invented times. The v1 records remain in the old unit untouched — never moved, overwritten, or deleted — and old builds cannot read the new data. Verify that the assistant page shows the original tasks with their execution history and that `GET /api/personal-assistant/config` returns the query settings.
4. Client display preferences (view, filters, page) are keyed by a hash of the assistant working directory; the first open after the upgrade shows the default view.
