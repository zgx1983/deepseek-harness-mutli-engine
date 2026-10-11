# Main Agent engine detailed design

English | [中文](detailed-design.zh.md)

Status: proposed reference, not implemented. Owner: main-agent-engine implementer and architecture reviewer. Created: 2026-09-29. Review or expire: 2026-10-29. Promotion target: architecture, core subsystem, and provider package documentation after implementation. Expiry requires review, not automatic deletion.

<a id="summary"></a>

## Summary

This proposed reference defines routing, persistence and lifecycle obligations. Read the [overview](overview.md) first. Names below are proposed API names, not existing exports. An implementation may rename them consistently, but must preserve each stated behavior and update all consumers.

The [end-to-end plan](end-to-end-plan.md) updates this proposal with the requested first-message engine lock, concrete source gaps, SDK parameter routing and recovery packets. Its selection rule supersedes the creation-time lock described below.

<a id="contents"></a>

## Contents

- [Registration and selection](#registration-and-selection)
- [Shared runtime](#shared-runtime)
- [Durable data](#durable-data)
- [Input and recovery](#input-and-recovery)
- [Events and presentation](#events-and-presentation)
- [Provider adapters](#provider-adapters)
- [Compatibility and errors](#compatibility-and-errors)

<a id="registration-and-selection"></a>

## Registration and selection

`AgentEngineId` is a branded string. `registerEngine(id, definition)` returns an effect-owned disposer and rejects duplicates. A definition includes an `AgentFactory`, capabilities, and provider-owned model resolution. Disposing a provider first rejects new work, cancels and drains its owned agents, and only then removes its registration. One provider unload must not stop agents owned by another provider.

Create accepts a separate `engineId`; model `provider` retains its LLM meaning. Resolve selection exactly once in order: explicit request, preset selection, configured default. Validate preset compatibility, model options and execution environment before publication. Persist the resolved engine before dispatching any external input. Resume resolves the persisted identity and rejects a conflicting caller override. For legacy sessions lacking engine identity, use a documented native-only compatibility rule, never the current default.

Capabilities use explicit modes: `textStream = delta | item`, `steering = active-turn | unsupported`, `resume = native | unsupported`, `fork = native | unsupported`, plus approval, user-input and attachment support. Model changes are initially allowed only while idle and only if the provider validates them. Unsupported requests fail before inbox mutation. Installed availability and authenticated readiness are separate; listing an engine must not start it or trigger paid work.

Model registration is endpoint-aware. A provider adapter declares one or more named endpoints when it registers; an endpoint names a base URL and an authentication reference, never a credential value, and one provider may serve several models over several endpoints. An engine definition declares the endpoint ids it routes to. The engine resolved for a session therefore selects which provider endpoints its model catalog and call routing may use: the native engine serves the native endpoint, a Claude engine serves the Anthropic endpoint, and a Codex engine serves an OpenAI-compatible endpoint, so one deployment hosts all of them without sharing routing. A model whose provider exposes no endpoint configured for the active engine is not offered to that session.

One session resolves one engine exactly once. The resolved engine is persisted before dispatch and is immutable for the life of the session: resume honors the persisted identity and rejects a conflicting caller override, and a post-creation engine change is rejected, never silently migrated to another engine.

<a id="shared-runtime"></a>

## Shared runtime

Keep the registry as the consumer-facing owner. Extract creation transactions, persistence write ownership, scope setup/publication, inbox projection registration and quiescent disposal only where they are engine-independent. The native model-step driver stays in `agent-loop`. Preserve caller-owned creation cancellation, setup commit, ordered creation events and rollback behavior from the existing factory; do not replace these with a second ad hoc lifecycle.

`followup()` queues one message per turn. `whenIdle()` means whole-agent quiescence, not success of one message. Maintenance claims true idle and holds later input. `cancel(keepInbox)` preserves the existing queued-input behavior; external acknowledgement or process exit must settle before idle. Internal states may include starting, submitting, running, waiting-interaction and stopping, while public status remains the existing idle/running pair and waiting UI derives from pending interactions.

The existing `Agent.steer()` and `inject()` promise a next-step boundary that external engines may not expose. Add capability-aware admission and audit every direct caller before external providers are enabled. An unsupported adapter must reject synchronously before enqueueing; do not silently convert steering to a future turn or fabricate a model step. Native methods retain their current behavior. Goals, guards and injectors requiring native steps must be excluded from incompatible presets at composition time.

<a id="durable-data"></a>

## Durable data

The following payloads are a proposed logical schema. IDs crossing processes are branded in TypeScript; wire parsing validates strings and reconstructs brands. No credentials, process handles or absolute login-store paths belong in these records. Environment references identify the execution host and workspace; storage references must remain resolvable without exposing secrets.

| Record | Required data | Meaning |
|---|---|---|
| engine/selected | engineId, adapterVersion, historyMode, environmentRef | Immutable initial routing |
| engine/bound | engineId, nativeSessionId, runtimeVersion, storageRef | Confirmed native identity |
| engine/input-submitted | inputId, attemptId, contentRef, operation | Durable intent before dispatch |
| engine/input-accepted | inputId, attemptId, nativeTurnId when available | Provider evidence of acceptance |
| engine/input-unresolved | inputId, attemptId, reason | Delivery outcome cannot be established |
| engine/item-settled | nativeItemId, revision, category, payload | Observable settled content or activity |
| engine/turn-settled | turnId, outcome, usage when supplied | Terminal execution fact |

`contentRef` must point to committed user content or immutable attachments that the reader can resolve; it is not a process-local pointer. Store submission intent and its content before sending. The inbox-to-submission transition must be atomic or reconstructable using the same input ID so a crash cannot lose queued work. A durable outbox projection derives pending, accepted and unresolved submissions. Capture native identity as soon as the provider reveals it; an external failure before identity capture remains explicitly unresolved.

Keep common turn/start and turn/end only after verifying their consumers do not require model steps. Do not emit native step/start, request/header or assistant attempt records with fabricated model-request data. External content uses provider-neutral engine events and a dedicated conversation projection until exact equivalence is demonstrated. Register projections outside the native loop so read-only history works without the external executable.

Required-on-read engine events and their pure projection definitions must ship with the common reader, not only with an optional provider. Uninstalling the execution plugin therefore preserves history rendering. A reader that does not understand essential engine events must refuse them. Follow [persistence type review](../../cookbook/reviewing-persistence-type-changes.md); do not mark essential events ignorable to bypass compatibility. Structural format changes require the existing adjacent migration process.

<a id="input-and-recovery"></a>

## Input and recovery

Create prepares the DSH session and scoped Agent, commits engine selection, publishes through the existing lifecycle, then allows queued input to run. The provider creates a native session lazily. Resume acquires DSH write ownership before opening native state, validates engine/environment/version support and reconciles unfinished submissions before accepting more input. A lock in one DSH process does not protect against native CLI use elsewhere; first release documents native-store exclusive-use requirements.

| Failure window | Required behavior |
|---|---|
| Before submitted record | Keep durable queued input |
| After submitted, before acceptance evidence | Reconcile; never automatically resend uncertain input |
| Native turn completed, DSH terminal record absent | Import available completion once, otherwise expose unresolved recovery |
| Native history missing | Keep DSH history readable; fail resume explicitly |
| Provider unavailable | Keep history readable; fail execution without fallback |
| User cancels during approval | Cancel interaction, reject late answers, stop engine and drain |
| Cancellation races success | Preserve observed side effects and terminal evidence; apply documented first-cause cancellation semantics |

Persist a deduplication key from native session/turn/item identity where available. For transports without stable replay identity, do not promise exactly-once import; require an explicit recovery decision. SDK automatic retry is not authorization to replay a turn that can edit files. A user-authorized new attempt receives a new attempt ID and retains the unresolved predecessor.

<a id="events-and-presentation"></a>

## Events and presentation

Transient deltas update live text; settlement commits the complete observed message and its revision before publishing a committed-end notification. Reconnect reads committed projections then attaches live updates with a sequence cursor. A transient sequence gap requires snapshot refresh. Do not persist every token by default or fabricate hidden reasoning, complete prompts, tool output or usage that the provider did not expose.

Use dedicated cards for external commands, file changes and tools, carrying an execution-source label and native item ID. These are observation records and must never invoke `ctx.tools.execute`. Approval cards reference session, turn and request identity, offer only provider-supported choices and settle once. On restart, only a re-established native pending request can become answerable; old UI requests are expired.

New-chat UI opens with an engine-selection dropdown listing every registered engine. Choosing one fixes the session engine, and the model dropdown that follows shows only providers and models whose configured endpoints support that engine. Existing sessions display their fixed engine and cannot change it. Route model catalog, validation and reasoning options through the engine definition; do not send external model names into `ctx.llm`. Localized UI explains unsupported operations and unresolved delivery. All entry points, including both DSH SDKs, enforce the same checks and expose the same terminal outcomes.

<a id="provider-adapters"></a>

## Provider adapters

Claude uses official query/session APIs, captures the explicit session ID and enables persistence for resumable chats. Translate observed messages, terminal results and permission/user-input callbacks. Preserve the existing managed spawn integration. Confirm interruption, incremental input and acceptance evidence against the pinned SDK before advertising them. `canUseTool` is not an all-tool policy hook; evaluate `PreToolUse` separately if all-tool inspection is required.

Codex App Server owns initialize, thread creation/resume, turn start/interrupt, notifications and server requests. Verify each method against the pinned protocol. Reuse validated wire parsing and managed process ownership, but remove ephemeral and deny-all-interaction assumptions for main sessions. Prefer one owned process per live DSH session initially; pooling requires separate ownership design. The optional TypeScript SDK transport exposes only verified methods and must establish a supported managed-process strategy before shipping. The Codex engine reaches GPT models natively through the pinned app-server protocol: thread routing follows Codex's own model configuration, and the engine definition declares the OpenAI-compatible endpoint it serves. The engine never routes external model names through `ctx.llm`.

Configuration owns runtime selection, permission mode, environment overlay, working directory policy and disposal grace. Authentication remains in provider-supported credential storage; record references, not secrets. Do not silently use a host executable when the pinned payload is missing. Do not claim native SDK tool execution passes through DSH filesystem or sandbox providers; validate process confinement and engine-native policy separately.

<a id="compatibility-and-errors"></a>

## Compatibility and errors

First release excludes cross-engine in-place switching, arbitrary DSH event-prefix forks of external sessions, cross-host native-state migration, DSH request retries around external turns and automatic DSH tool export. Unsupported fork must be rejected before native `buildForkSeed` processing. A later native fork requires a verified mapping from the selected UI cut to an engine checkpoint.

Expose stable errors for engine unavailable, unsupported capability, engine mismatch, native state missing, unresolved delivery, incompatible runtime and writer conflict. Keep raw provider errors in protected diagnostics, with sanitized user messages. Do not invent token cost when usage is absent. Preserve external side effects after cancellation; cancellation is not rollback.
