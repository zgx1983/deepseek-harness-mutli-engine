# Main Agent engine implementation packets

English | [中文](implementation-plan.zh.md)

Status: proposed reference, not implemented. Owner: main-agent-engine implementer and architecture reviewer. Created: 2026-09-29. Review or expire: 2026-10-29. Promotion target: architecture, core subsystem, and provider package documentation after implementation. Expiry requires review, not automatic deletion.

<a id="summary"></a>

## Summary

A lightweight model implements one packet at a time after reading its dependencies and the [detailed design](detailed-design.md). Each packet ends with reviewable code, updated owning documentation and recorded verification. This plan does not authorize implementing the feature during the current documentation task.

For the current working-tree audit and first-message engine-lock implementation, use the [end-to-end plan](end-to-end-plan.md). Its packet order refines this earlier proposal.

<a id="contents"></a>

## Contents

- [Readiness gates](#readiness-gates)
- [Ordered packets](#ordered-packets)
- [Acceptance matrix](#acceptance-matrix)
- [Implementer handoff](#implementer-handoff)

<a id="readiness-gates"></a>

## Readiness gates

The architecture reviewer must accept the external-history exception and the selected Codex transport before production implementation. The provider implementer must record pinned-version evidence for resume, cancellation, input acceptance, item identity, approval round trips and process teardown. Unsupported capabilities stay disabled. Missing evidence blocks the dependent packet, not independent documentation or native refactoring.

The current design is sufficient for bounded work packets, but not for blindly generating all adapters. SDK behavior and persistent schema placement are deliberate verification gates. When source contradicts a proposed API, report the exact conflict and revise this design before changing semantics. Never solve a mismatch by disabling invariants or making required history ignorable.

<a id="ordered-packets"></a>

## Ordered packets

| Packet | Dependencies and read scope | Deliverable and exit condition |
|---|---|---|
| P0: evidence | Existing Claude/Codex subagent sources; pinned SDK/protocol | Capability table backed by fixtures or real runtime evidence; architecture decisions recorded |
| P1: routing | P0 decisions; core/agent and all setFactory callers | Named registrations, explicit default resolution, endpoint-aware model registration, persisted engine-selection design; native callers updated |
| P2: lifecycle | P1; core/agent-loop creation/resume and projections | Shared lifecycle extraction; native creation, rollback, cancel and dispose behavior preserved |
| P3: records | P1; core/session, session-format, persistence review | Required engine events, common read projections, outbox and recovery; compatibility acknowledgement |
| P4: API and UI | P2/P3; api/session-controller and conversation renderers | Engine catalog, engine-selection dropdown, endpoint-filtered model catalog, localized cards and capability rejection; mock engine works end to end |
| P5: Claude | P0/P4; managed Claude spawn and query APIs | Persistent multi-turn main chat, stop, restore and approval with focused integration evidence |
| P6: Codex | P0/P4; Codex wire and app-server methods | Persistent multi-turn main chat and supported controls with protocol evidence |
| P7: distribution | P5/P6; bundle composition, TS/Python SDK, snapshots | Optional provider bundles, native default retained, both SDK expectations and user docs updated |

P1 must decide how cold resume reads engine selection before choosing a factory; do not make each factory open the same writable session to discover its owner. Prefer a single read inspection followed by one writer acquisition with identity revalidation. P3 must then implement the chosen selection encoding and close the inspection/write race. No external provider is enabled until both packets agree.

<a id="acceptance-matrix"></a>

## Acceptance matrix

| Scenario | Required evidence |
|---|---|
| Two engines registered | Both create root chats; duplicate registration rejects |
| Default changed after creation | Existing session resumes the persisted engine |
| Native regression | Existing creation rollback, setup, inbox, maintenance and disposal tests remain green |
| External two-turn conversation | Second turn observes first-turn context without manual transcript replay |
| Process restart | Same native identity resumes; missing state reports an explicit failure |
| Submission ambiguity | No automatic duplicate dispatch after a crash before acknowledgement |
| Approval cancellation | No stale approval can execute work after cancellation |
| External tool activity | One activity card; no second execution through DSH tools |
| Stream reconnect | Settled content appears once; transient gaps refresh |
| Provider removed | Common reader still renders history; continuation fails clearly |
| Unsupported steering/fork | API rejects before queue/seed mutation |
| Runtime cleanup | Disposal awaits exit and does not terminate sibling-provider sessions |
| SDK compatibility | TypeScript and Python expected outputs include engine events and errors |

Use keyless recorded-session fixtures for user-visible event sequences and real-process tests for lifecycle behavior. Real API checks are a separate credentialed stage and must be reported as unrun when unavailable. Follow [testing policy](../../testing.md) and [pre-push checks](../../../.agents/skills/dsh-pre-push-checks/SKILL.md); do not substitute a full-suite run for focused semantic evidence. This document lists planned verification, not results.

<a id="implementer-handoff"></a>

## Implementer handoff

Each assignment names one packet, allowed files, prerequisite evidence and expected outputs. Read root/subtree instructions, the packet and its referenced owners before editing. Report changed APIs, consumer updates, tests actually run, unresolved facts and the next eligible packet. Avoid parallel agents editing core lifecycle and persistence types until those interfaces are settled.

Suggested assignment: implement P1 only after P0 decisions are recorded; use the detailed design for selection semantics; update every factory consumer; preserve native behavior; provide focused routing tests and documentation; do not add SDK calls, UI changes or a fallback to another engine. A reviewer then checks the packet before P2/P3 begin.

<a id="reasoning-mapping-todo"></a>

## TODO: provider and engine reasoning mappings

Recorded 2026-10-03. The user reports that the current reasoning mapping is unsuitable; the replacement semantics remain to be agreed. Record this follow-up without changing execution behavior.

- [ ] Review the distinction between Harness selectable levels, provider-native parameters, and Claude/Codex parameters; define supported mappings per exact model instead of assuming identical names have identical meaning.
- [ ] Verify the configured Kimi, GLM and DeepSeek routes, including whether their endpoints accept the chosen engine values; distinguish absent capability, disabled thinking and an unspecified default.
- [ ] Add provider/model configuration UI for supported levels, mapped values, defaults and optional engine overrides after the mapping rules are agreed.
- [ ] Cover model/provider switches, saved selections and actual outgoing parameters with focused regression evidence; update the [implementation reference](../../main-agent-engines.md#engine-reasoning-mapping).

<a id="codex-command-discovery-todo"></a>

## TODO: Codex command discovery and execution

Recorded 2026-10-03. Defer implementation and real Codex calls until the user reports that their token allowance has recovered and asks to resume.

- [ ] Check the installed Codex version's command discovery capabilities; distinguish CLI commands from app-server operations and expose only commands with an implemented execution route.
- [ ] Adapt the selected session's command menu and dispatch, including shared model/permission controls, command arguments, process replacement and catalog invalidation.
- [ ] Keep command discovery safe for empty sessions: querying a catalog must not create a binding that later resumes nonexistent history; preserve existing-session recovery checks.
- [ ] Verify Desktop's actual loaded bundles and run focused regression and real Codex acceptance after the deferred work is authorized.
