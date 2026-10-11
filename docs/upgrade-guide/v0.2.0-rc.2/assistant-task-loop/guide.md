---
kind: upgrade-guide
description: "Assistant tasks gain execution config and deliverable-gated review; todos, a knowledge directory, session navigation, and a scoped execution tool are added; the storage schema evolves additively inside v2."
---

# Assistant task loop, todos, and knowledge

English | [中文](guide.zh.md)

## Change

Previously, starting a task created the execution session without an engine or model; a successful turn end moved the task into review by itself; execution sessions were read-only records; and todos and long-term knowledge did not exist.

After this batch:

- **Execution config.** Tasks carry engine, provider, and model config falling back task → parent → plugin defaults (`defaultEngineId`, paired `defaultProvider` + `defaultModel`). `startTask` accepts optional overrides. The startup chain resolves the config, creates the session with the engine, installs the model via `selectModel`, and submits the kickoff message via `prompt`; any failing step lands the task in needs-attention with the reason. Invalid configs reject the start; the Host never substitutes a model.
- **Deliverable-gated review.** Review is reached only through the scoped `task_execution` tool's `deliver`. A turn ending without a submission lands in needs-attention — automations relying on the old automatic review should watch for `deliverable-submitted` activities or the results list.
- **Scoped tool, three engines.** Execution sessions get `task_execution` (query task, report progress/blocked, deliver). The binding comes from the Host's Session–Execution association; only an in-flight attempt may read or write. Native sessions use framework registration; Claude and Codex reach the tool through the session-owned MCP bridge in `dsh-subagent-in-process-driver`, which now also starts for execution-only scopes. Existing Team behavior is unchanged.
- **Session navigation.** Task cards, details, and result references offer "Open session" for the exact execution session; a back action restores the assistant view. Previously these were read-only records.
- **Conversational acceptance.** The coordinator tool's new `accept` action applies acceptance only after user confirmation through user-questions, as the user's operation; without that service the panel path remains.
- **Todos.** New `todos` table and `listTodos` / `createTodo` / `updateTodo` / `completeTodo` / `reopenTodo` / `cancelTodo` / `restoreTodo` / `convertTodo` operations. `convertTodo` commits task creation and todo status in one transaction and replays by `requestId`. Task records gain optional `sourceTodoIds`, `sourceKnowledgeId`, and execution-config fields.
- **Knowledge.** New `knowledge` index table and `listKnowledge` / `getKnowledge` / `createKnowledge` / `updateKnowledge` / `importKnowledge` / `refreshKnowledge` operations. Markdown files under `knowledgeDirectory` (default `$DSH_HOME/personal-assistant/knowledge`) are the authoritative body; the database keeps a rebuildable index. Update conflicts report `knowledge-conflict`.
- **Config route.** The plugin config gains `defaultEngineId`, `defaultProvider` + `defaultModel`, and `knowledgeDirectory`; the GET response returns them.
- **Storage.** The domain stays at version 2: added fields are optional and new tables start empty, so 2.x media open unchanged with no migration step.

## Migration

1. Back up `$DSH_HOME/storages/personal-assistant.db` and the knowledge directory.
2. Rebuild and install the plugin, then restart the profile so Host routes, the client bundle, and the MCP bridge load together.
3. Verify: the config route returns `knowledgeDirectory`; existing tasks are unchanged; new executions show their engine/provider/model snapshot.
