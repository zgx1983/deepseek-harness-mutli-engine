# Agent Note: session engine selection — a log-only event, immutable after dispatch

Status: implemented

English | [中文](2026-09-29-session-engine-selection.zh.md)

## Problem

A main chat must be able to pick one execution engine (the native loop, a Claude SDK engine, or a Codex engine) and keep that choice for the life of the session: the engine decides how the session executes, so changing it after history exists would replay work the engine cannot act on. The engine also routes model choices — different engines serve different providers over different endpoints (the Codex engine reaches GPT models through its OpenAI-compatible endpoint; the native loop serves the regular LLM registry). The engine identity is durable (survives restart and resume) and independent of the LLM provider/model.

## Decision

**Persist the engine selection as a log-only `engine/selected` session event, not a session-header field.** A header field addition is classified by `verify-persistence-changes` as `optional-property-added` on a required-on-read root with `requiresVersionBump: true`, forcing a Session-format version bump and a full adjacent migration package. A new merge-extensible event root is classified `root-added` with `requiresVersionBump: false` (same-version allowed), and the generated `KNOWN_SESSION_EVENT_TYPES` set absorbs it so no in-repo reader refuses the log. The design's durable `engine/selected` record (`engineId, adapterVersion, historyMode, environmentRef`) maps directly onto the event payload; only `engineId` is written today.

**One engine per session, resolved exactly once, immutable after the first dispatch.** `SessionCreateRequest.engineId` names a registered engine; an omitted id resolves the deployment default (the native loop) and records no event. `selectEngine` fixes initial routing: it succeeds only while the session has no engine and no `turn/start` / `user/message` / `request/header` (no dispatched work), appends `engine/selected`, and is immutable afterwards — a conflicting re-selection returns `session/engine-conflict`, a dispatched session returns `session/engine-locked`, an unknown engine returns `engine/not-found`. Resume and explicit-id adoption read the event back (`engineFromEvents`) and reject a conflicting caller override with `session/engine-conflict`. Legacy sessions lacking the event use the documented native-only compatibility rule and can never retroactively pick an engine.

**Engine registration is a separate concern from the LLM factory.** `ctx.agents.registerEngine(id, definition)` declares name, capability modes (`textStream`, `steering`, `resume`, `fork`, plus approval/user-input/attachment), the endpoint ids the engine routes to, and an optional engine-owned `AgentFactory`; `create`/`resume` route through the engine's factory when present. The native engine is registered by `agent-loop` alongside `setFactory`.

**Model registration is endpoint-aware.** Provider adapters declare named endpoints on `providerInfo`; models may narrow their reachable endpoint set on `listModels` entries. `providerServesEngine`/`modelServesEngine` filter the model catalog to providers and models whose endpoints the active engine routes to; an engine with an empty endpoint set (native) reaches everything.

## Consequences

`engineCatalog()` lists registered engines; `modelCatalog(engineId)` filters by the engine's endpoints. The GUI composer shows an engine-selection dropdown beside the model seat (`conversation.input.engine`), disabled once the session's engine is fixed, and the per-session model directory filters groups/models by the engine's endpoints via the `engineSelection` projection. The Codex main-chat engine (`registerCodexEngine`) registers the `codex` engine and drives turns through the app-server protocol; the Claude main-chat engine (`registerClaudeEngine`) registers the `claude` engine and drives turns through the official Agent SDK over one managed CLI process in streaming-input mode, capturing the SDK session id for a later resume gate. Both record observable content as the log-only `engine/input-submitted`, `engine/item-settled`, and `engine/turn-settled` events (declared on the common reader in `dsh-session`); steering, injection, fork, approval, and native resume stay disabled until the design's pinned-version evidence gates pass. Two same-version persistence acknowledgements were recorded (`2026-09-29-agent-engine-selected`, `2026-09-29-agent-engine-codex-events`).

## Alternatives considered

- **Engine in `SessionHeader`** — durable and simple to read client-side, but requires a Session-format version bump and adjacent migration package for one optional field; rejected in favor of the event.
- **Engine selection as a factory-global or per-process default** — cannot be per-session or immutable; rejected.
- **Routing external engine content through native `assistant/message` events** — would fabricate a model step the engine never produced; the Codex engine emits provider-neutral engine events instead, with a dedicated conversation projection as the later gate.
