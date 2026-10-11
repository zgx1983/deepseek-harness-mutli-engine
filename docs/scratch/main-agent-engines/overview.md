# Pluggable main Agent engines

English | [中文](overview.zh.md)

Status: proposed reference, not implemented. Owner: main-agent-engine implementer and architecture reviewer. Created: 2026-09-29. Review or expire: 2026-10-29. Promotion target: architecture, core subsystem, and provider package documentation after implementation. Expiry requires review, not automatic deletion.

<a id="summary"></a>

## Summary

Let a root chat select the native DSH loop, Claude Agent SDK, or a Codex provider. DSH owns the chat application and observable record; the selected engine owns execution. This proposal requires shared API changes before providers become independently installable plugins. It does not route user messages through a subagent delegation tool.

<a id="contents"></a>

## Contents

- [Evidence](#evidence)
- [Architecture](#architecture)
- [Decisions](#decisions)
- [Handoff](#handoff)

<a id="evidence"></a>

## Evidence

Repository evidence was inspected as source, without running either external engine. [AgentFactory](../../../packages/core/agent/src/index.ts) already provides create/resume, but `setFactory()` rejects a second factory. [Agent](../../../packages/core/agent/src/runtime-types.ts) includes queue, cancellation, maintenance, steering and injection obligations. [AgentLoop](../../../packages/core/agent-loop/src/index.ts) owns creation and registers inbox/turn projections. [Session commands](../../../packages/api/session-controller/src/commands.ts) resolve model selection through `ctx.llm` and construct native fork seeds.

The existing [Claude provider](../../../packages/subagent/subagent-claude-code/src/run.ts) uses SDK 0.3.263 with persistence disabled and unattended interaction handling. The [Codex provider](../../../packages/subagent/subagent-codex/src/run.ts) uses app-server with a pinned 0.153.4 runtime. Both are one-shot subagents. Extract reusable process/protocol code only when the main provider needs it; their final-answer-only behavior is not the main-chat adapter.

Official documentation inspected on 2026-09-29: [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), and [Codex App Server](https://learn.chatgpt.com/docs/app-server). Live documentation may describe capabilities newer than the repository pins; implementation must verify the pinned runtime, not assume documentation parity.

<a id="architecture"></a>

## Architecture

```text
Web / Desktop / DSH SDK
          |
Session API + engine capability checks
          |
Agent registry + named factory routing
     /             |              \
native loop    Claude SDK      Codex provider
     \             |              /
      durable chat events + UI projections
```

Extend `dsh-agent` with named factories and engine capabilities. Keep `dsh-agent-loop` as the native provider. A proposed `dsh-agent-runtime` owns reusable lifecycle and queue machinery; extract it incrementally after proving native behavior unchanged. Proposed `dsh-agent-claude` and `dsh-agent-codex` packages own external execution. Providers register through Cordis effects; bundles install their configuration and pinned dependencies. Application startup remains a `dsh` profile.

<a id="decisions"></a>

## Decisions

Use Claude Agent SDK for Claude. Prefer Codex App Server for interactive main chats because it exposes approvals and active-turn control. A strict `@openai/codex-sdk` provider remains a valid reduced-capability option: sequential turns, observed item streams, and verified cancellation/resume. The app-server recommendation is a proposed transport choice, not a claim that the TypeScript SDK provides its methods.

Persist engine identity independently from LLM provider/model. Fix the engine for each session in the first release. Changing the global default affects only new sessions. Cross-engine transfer creates a new session with an explicitly recorded summary; it is not lossless resume. Native external tools remain engine-owned initially; DSH tool bridging is a later capability. Model registration is endpoint-aware: provider adapters declare named endpoints, and each engine definition binds to the endpoints it serves, so different agents route to different providers without sharing credentials or base URLs.

The current [architecture](../../architecture.md) requires reconstructable model inputs from the Session log. External SDK output does not establish that guarantee. Proposed external sessions instead record submitted input and observable execution while native engine data owns exact continuation. This exception requires explicit architecture/invariant review before implementation; native DSH keeps its existing guarantee.

<a id="handoff"></a>

## Handoff

Use the [detailed design](detailed-design.md) as the proposed behavioral specification and the [implementation plan](implementation-plan.md) as ordered work packets. These documents deliberately identify validation gates where lightweight implementers must stop rather than invent SDK behavior. No engine code, external calls, or runtime verification is included in this documentation change.
