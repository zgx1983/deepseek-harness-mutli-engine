---
kind: upgrade-guide
description: "A route offering `xhigh` or `high` without a configured default now sends that level instead of no reasoning parameter."
---

# Reasoning level defaults to XHigh or High

English | [中文](guide.zh.md)

## Change

A route that offers an `xhigh` or `high` reasoning level but configures no default now treats the strongest of the two as its default — `xhigh` first, compared lowercased against the selectable id — so a selection that omits an effort is materialized as that level, saved with the model for new sessions, and sent to the engine explicitly.

Previously an omitted effort reached the endpoint unnamed, and the model picker showed a **Default** row (ACP: **Provider default**). That row survives only for a route offering neither level.

Who is affected: anyone whose route declares `reasoningEfforts` (or inherits the harness levels) containing `high` or `xhigh` while the `llm-pi-ai` `reasoning` field and the engine's `defaultReasoningEffort` stay unset. Their requests now carry that level where they carried none, which changes model behavior and can raise cost. A configured route default still wins, and an adapter whose configured level the exact model cannot take still refuses with `UNSUPPORTED_REASONING_EFFORT`.

## Migration

1. To keep the endpoint's own unspecified default, leave neither level selectable: rename the ids in `reasoningEfforts`, for example `{ off: null, standard: high, max: xhigh }`. The picker then keeps its provider-default entry.
2. To pin the level the harness now implies, declare it: `reasoningEfforts: { off: null, high: high, xhigh: xhigh }` with `defaultReasoningEffort: xhigh` on the Claude or Codex engine, or `reasoning: xhigh` on `llm-pi-ai`.
3. Confirm in a session log that `request/header` carries the intended `reasoningEffort`, and that the picker's checked row matches it.
