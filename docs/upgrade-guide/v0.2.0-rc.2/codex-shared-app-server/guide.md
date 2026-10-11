---
kind: upgrade-guide
description: "The Codex main engine now serves every ordinary session from one shared app-server child process with a shared native home; sessions select routes registered at startup."
---

# Codex sessions share one app-server process

English | [中文](guide.zh.md)

## Change

Each Codex main session previously spawned its own app-server child process and used its own hashed `CODEX_HOME` under `$DSH_HOME/engines/codex/session-homes/<sha256(sessionId)>`. Every session resolved its provider route, model catalog, and credentials immediately before its own spawn.

Now the engine starts one shared app-server child per process at startup and every ordinary conversation attaches to it as a native thread. Provider routes are pinned from the `providers` map and `provider` key of the `main-engine-codex` config at child startup, and each thread selects its route through the native `modelProvider` field. A session selecting a route outside that registered set now fails loudly instead of spawning a private child. Configuration or credential changes restart the shared child between turns, and every session reattaches its thread through `thread/resume`.

Conversations carry one shared native home at `$DSH_HOME/engines/codex/shared-home`, with shared SQLite and log directories. Sessions persisted by a previous release resume unchanged: their rollouts are copied read-only out of the old per-session home. Sessions whose agent scope carries Harness Team tools keep a dedicated per-session child and home, because their per-agent MCP bridge needs a private process.

## Migration

1. Name every provider route sessions may select under `providers` in the `main-engine-codex` config of `cordis.yml`; a route absent from that map and from `provider` fails preparation with the registered-route list.
2. Restart the process once after upgrading; existing Codex sessions then resume from the shared home without further action.
3. Confirm: a new session runs with a single `app-server` child in the process tree, and a pre-upgrade session continues its conversation instead of reporting missing history.
