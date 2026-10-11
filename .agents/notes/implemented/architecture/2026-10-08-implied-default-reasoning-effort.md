# Agent Note: an unnamed reasoning effort resolves to the offered High or XHigh level

Status: implemented

English | [中文](2026-10-08-implied-default-reasoning-effort.zh.md)

## Problem

A route that offered a `high` or `xhigh` reasoning level but configured no default left every request unnamed. The model picker showed a **Default** row, ACP showed **Provider default**, and the actual level came from whatever each engine does on its own — Claude Code's internal default, Codex's, or the gateway's. Nothing tied the displayed state to the request: the same picker showed "Default" for a route that thought at `high` and for one that did not think at all, and a deployment that wanted a stated level had to repeat it in `reasoningEfforts`/`defaultReasoningEffort` next to a level set that already named it.

## Decision

**The producer of reasoning metadata names the implied default.** `impliedDefaultEffort(efforts)` in `@deepseek-ai/dsh-llm` returns the strongest offered selectable id spelled `xhigh`, then `high`, compared lowercased so a route may write `High`; it returns nothing when a route offers neither. `llm-pi-ai` calls it when the profile configures no `reasoning` value, and `mapEngineReasoning` (in `@deepseek-ai/dsh-agent`, serving Claude and Codex) falls back to it when neither the deployment nor the adapter named an offerable default. `llm-replay` mirrors the live routes so recorded sessions match.

Consumers are unchanged because they already read `LlmModelReasoningInfo.defaultEffort`: `SessionController.modelCatalog` advertises the level, `selectModel` materializes it into the selection, the picker drops its provider-default entry, and ACP drops its **Provider default** option. The `/model` popup and the composer seat read the same catalog.

The implication runs at the metadata producers, not in `LlmRuntime.normalizeModelInfo`. An adapter whose configured level the exact model cannot take therefore still reports no default, and the request path still refuses that deployment value with `UNSUPPORTED_REASONING_EFFORT` instead of having another level quietly substituted. An explicitly configured default also still wins, and a configured default that is not offered still throws when the engine mapping resolves.

## Alternatives considered

- **Derive in `LlmRuntime.normalizeModelInfo`** — rejected: metadata normalization cannot tell "no default configured" from "a configured default this exact model rejects", so the implied level would supersede the deployment value that `llm-pi-ai` deliberately refuses at request time.
- **Derive in the browser or in each consumer** — rejected: the picker, ACP, and the session controller would each need the rule, and a session that never re-selected a model would still send nothing while its picker displayed a level.
- **Prefer `high` over `xhigh`** — rejected: if a route offers `xhigh`, that is the strongest level an engine that runs its strongest default lands on; preferring `high` would state a weaker level than the route advertises.
- **A configuration switch over the implied ids** — not taken: a route that wants its endpoint's unspecified default already expresses that by not offering these ids, and renaming them (for example `max: xhigh`) keeps the level reachable.

## Consequences

Given up: a route can no longer offer `high`/`xhigh` and still send an unnamed effort — the level is materialized, saved with the model for new sessions, and sent explicitly, which can raise cost where a gateway defaulted lower. Bought: the displayed level and the dispatched parameter agree, and a deployment no longer restates the default beside the level set.

Verification: `packages/llm/llm/tests/reasoning-default.spec.ts` covers the id matching and priority; `packages/llm/llm-pi-ai/tests/adapter.spec.ts` and `catalog.spec.ts` cover an unconfigured route, a configured route, and the refusing case; `packages/core/agent/tests/engine-reasoning.spec.ts` covers the engine fallback and the strict rejection of an unoffered configured default; the `declared-reasoning` web scenario covers the picker. The `implied-reasoning-default` upgrade guide states the migration.
