---
kind: upgrade-guide
description: "Personal-assistant task records move into a SQLite-backed storage domain with a fixed working directory, and the client-side replacement path is removed."
---

# Personal-assistant tasks move to SQLite storage with a fixed working directory

English | [中文](guide.zh.md)

## Change

In v0.2.0-rc.2, the `dsh-personal-assistant` plugin stored tasks and the coordinator reference in `<DSH_HOME>/personal-assistant/tasks.v1.json`, created its coordinator conversation without a working directory, and let the client replace that conversation when the session catalog did not show it. The POST `/api/personal-assistant/tasks` route accepted the `dashboardReplaceCoordinatorSession` operation.

The plugin now keeps the same data in the `personal_assistant` storage domain — one `tasks` table keyed by task id plus a coordinator singleton holding the session reference, the `coordinatorDirectory` identity, and the `coordinatorHistory` entries (`corrupt-history` and `working-directory-moved`). The bundle routes this domain to the SQLite database at `$DSH_HOME/storages/personal-assistant.db` and keeps the base `json` default for every other domain. The plugin also resolves an assistant working directory — the optional `assistantWorkingDirectory` config value, defaulting to `<dataDirectory>/workspace` — and creates, reuses, migrates, and recovers the coordinator conversation only inside it; a mismatched directory migrates the conversation and keeps the old Session log, and another live Host confirming a different directory fails with a conflict message. The `dashboardReplaceCoordinatorSession` operation is removed; the client keeps the assigned identity and retries loading.

Task records do not migrate. A `tasks.v1.json` from the previous release stays on disk untouched and is no longer read or written.

## Migration

1. Restart the running profile so the Host routes, the storage rows, and the client bundle load together. The bundle patch inserts the `storage-sqlite` row and restates the `storage-domain` row with `routes: { personal_assistant: sqlite }`; profile compositions that override those rows must include the same route.
2. To keep working in the previous conversation directory, set `assistantWorkingDirectory` in the plugin's `cordis.yml` config to that absolute directory before the first page open. Without it, the default `<DSH_HOME>/personal-assistant/workspace` applies and the first open of the assistant page migrates the coordinator into it.
3. Recreate needed tasks after upgrading — records do not carry over. Confirm: GET `/api/personal-assistant/config` returns the resolved `assistantWorkingDirectory`, the assistant page opens its saved conversation, and `$DSH_HOME/storages/personal-assistant.db` exists. Then delete the stale `<DSH_HOME>/personal-assistant/tasks.v1.json` once you are sure nothing in it is still needed.
