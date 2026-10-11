# Persistent multi-engine Agent Teams: detailed design

English | [中文](persistent-agent-teams.zh.md)

Design reference with partially implemented targets; this proposal is not the current feature inventory. See the [owning package README](../../../packages/experimental/tool-agent-team/README.md) for behavior and the [feature migration and iteration checklist](../../../worktree-feature-list.md) for implemented and remaining work. Original design review: 2026-10-01; status checked: 2026-10-04.

## Summary

Harness owns the team roster, mailbox, shared tasks and scheduling. Each teammate owns a durable Harness Session executed by native AgentLoop, Claude Agent SDK or Codex app-server. Reuse the production main-engine drivers for continued conversations instead of the one-shot external subagent providers. A member can be awakened by Session identity after inactivity, interruption or process restart.

## Contents

- [Scope and current gaps](#scope)

- [Execution selection](#selection)

- [Member lifecycle](#lifecycle)

- [Mailbox and scheduling](#mailbox)

- [Claude integration](#claude)

- [Codex integration](#codex)

- [Shared services and persistence](#persistence)

- [Engine capabilities outside Harness](#gaps)

- [Implementation packets and acceptance](#implementation)

<a id="scope"></a>

## Scope and current gaps

Confirmed scope: persistent teammates, per-member engine/provider/model, parallel turns, Session-based wakeup, member messages, shared task DAG, human approvals, interruption, recovery and common UI. Recommended first release: native Lead with any of the three teammate engines; external Leads follow after team-tool bridging.

Current TeamRoster calls `subagents.startContinuable`; its durable member stores the delegation provider. TeamMailbox calls `root.steer()` for the Lead and `steerHostSubagentPrompt()` for children. Both external main-engine definitions currently reject steering and fork. These are specific integration gaps, not evidence that the engines cannot resume.

Do not overload the existing Team member `provider` field with a model vendor. Distinguish execution engine (`native` / `claude` / `codex`), model provider (registered LLM route), model ID, and existing delegation provider (`spawn` / `fork`). Historical teams must retain their original provider behavior.

<a id="selection"></a>

## Execution selection

### Alternatives

| Selection method | Benefit | Cost / recommendation |
|---|---|---|
| Inherit Lead selection | No extra choice. | External compatibility and cost may differ; allow only as an explicit team default policy. |
| Raw engine/provider/model on every spawn | Maximum flexibility. | Models can invent IDs and users repeat configuration; reserve for approved advanced overrides. |
| Execution profiles | Stable named choices, independently configured per engine. | Recommended public interface; introduces a small preset editor. |
| Role-to-profile mapping | Reviewer/coder tasks can pick deployment defaults. | Useful after profiles; roles remain advisory, never inferred from name strings. |

### Recommended initial interface

Add Team execution profiles, distinct from `dsh --profile` application profiles and Agent composition presets. Users create them in Settings → Agent Teams with three selectors: engine, provider filtered by endpoint compatibility, and exact model. Display endpoint availability without exposing secrets. Team settings choose one default profile; spawning a teammate may override it with another allowed profile.

Proposed configuration data below is illustrative JSON, not current Cordis configuration. Keep separate stored fields for engine and model provider. The Team service owns the validated configuration schema.

```json
{
  "executionProfiles": {
    "reviewer-claude": {
      "engineId": "claude",
      "modelProvider": "deepseek",
      "model": "deepseek-flash",
      "permissionPreset": "read-only"
    },
    "coder-codex": {
      "engineId": "codex",
      "modelProvider": "deepseek",
      "model": "deepseek-v4-pro"
    }
  },
  "defaultExecutionProfile": "reviewer-claude",
  "allowedExecutionProfiles": ["reviewer-claude", "coder-codex"],
  "allowExplicitExecutionOverride": false
}
```

The example permission name is illustrative and must resolve to an installed permission preset. Credentials come from the model provider service; never store API keys in profiles, tool parameters or Team events. Model-specific effort and context defaults remain in the existing engine/provider configuration; per-profile effort can be an optional validated override.

The model-facing spawn tool adds optional `executionProfile`; omission resolves the team default. Add `list_execution_profiles` returning allowed IDs, engines, providers, models and relevant capabilities. Do not expose arbitrary raw overrides until explicitly enabled; unknown or disallowed IDs fail before member creation.

```json
{
  "name": "reviewer",
  "description": "Review the implementation",
  "prompt": "Review the changed files and report concrete issues.",
  "context": "fresh",
  "executionProfile": "reviewer-claude"
}
```

Resolve profile choice once at creation, record the actual engine/provider/model/effort/policy alongside the profile ID, and use that recorded execution for later wakeups. Editing a preset must not silently change existing members. Future members use the new preset; existing members require an explicit idle-time model/provider update.

Engine locks after first accepted member input. Before that input, draft execution can change. Model/provider may change while idle through the same controller rules as main conversations; provider changes restart native execution where required. A different engine requires a new member Session.

No team default is inferred from a global UI model default. For optional `inherit-lead`, snapshot the Lead’s resolved selection at creation and validate compatibility; never fall back to another engine, provider or model silently.

Product choices remaining: whether the first release enables an explicit inherit-Lead policy, advanced raw overrides, and automatic role mappings. Implementation can proceed with named profiles plus an explicit team default without deciding these extensions.

<a id="lifecycle"></a>

## Member lifecycle

Introduce a Team member runtime provider implementing create/load/prepare/enqueue/interrupt/close for persistent Harness Sessions. The Team service owns membership and authorization; the runtime provider uses normal Agent construction and engine drivers. Keep historical continuable-subagent members on their legacy runtime through a tagged runtime descriptor.

Creation order: validate profile and permissions → allocate stable child Session ID → append and flush provisioning reservation in Lead → create child Session and execution selection → prepare native engine before prompt acceptance → bind native identity → accept initial input → mark member active. Avoid holding a Team mutation lock while waiting on SDK startup. On failure retain the reservation and diagnostic; reconciliation may finish the same operation but never silently reuse a name for another Session.

Separate durable member phase from runtime availability: provisioning/active/failed describe creation; running/inactive/loading/approval-pending describe current execution. A completed turn does not complete all assigned tasks, and inactivity is not success. Task ownership is released only through an explicit operation.

Session wakeup: authorize caller against Team membership → obtain single resident Agent under a per-Session load lock → read recorded execution and native binding → append durable input using idempotency key → schedule prepare/resume and execution. A Session ID identifies the target but is not an authorization credential.

No live process: Claude starts and resumes its native session; Codex starts with the member’s private home and resumes its bound thread. Missing native history for accepted inputs blocks wakeup. Recovery restores conversation state and executes a new turn; it does not promise resuming a cancelled shell command from its internal instruction position.

<a id="mailbox"></a>

## Mailbox and scheduling

Replace TeamMailbox’s hardcoded steer/delegation routing with a member-input service. Default delivery policy: idle target accepts and schedules a next turn; busy target accepts durable queued input for the next turn. Native step steering and Codex live steering are optional capability-gated modes. Claude defaults to turn-boundary delivery until streaming-input timing is verified for the pinned SDK.

Use TeamMessageId as the target admission idempotency key. Persist sender, target, content and queued intent in Lead; persist receipt/source in target before marking delivered in Lead. Delivered means target Harness durable acceptance, not model consumption. Track native submission separately using the engine input ledger; uncertain native delivery blocks replay and requires recovery acknowledgement.

Wake scheduling must process accepted queue entries after startup and after each terminal turn, including messages sent before application exit. Ordinary interrupt cancels the current turn and preserves queued inputs. Provide a separate paused state/action if the user wants no automatic next turn; process eviction is allowed only when idle and must preserve bindings.

Wait observes durable/runtime progress and never blocks a Team mutation lock. A waiting Lead must still allow teammates and mailbox processing to run; reject waits that cannot progress. Task readiness does not automatically wake an owner unless an explicit scheduling policy is enabled. Broadcast, if added, records one independently acknowledged message per recipient.

<a id="claude"></a>

## Claude integration

Use `createSdkMcpServer` and SDK tool definitions to expose the shared Team tool facade in-process. Pass it through `mcpServers` and log the actual team policy and tool definitions before they reach the model. Bind each server instance to the exact member Agent; tool arguments cannot choose caller identity or another Team. This also enables a Claude Lead later.

Bridge all existing nine Team tools plus execution-profile discovery through one shared dispatcher. Preserve Lead-only spawn/interrupt restrictions and existing task revision checks. Use native tool call IDs to correlate durable Harness call/result records; mark bridged calls so native activity observations do not create duplicate tool executions or result entries.

For permissions, pure roster/task reads may use an explicit safe allowlist. Spawn, interrupt and permission changes pass Team authorization and configured user policy; never blanket-auto-approve the MCP namespace. Ordinary shell/file approvals retain existing SDK callbacks. Each dialog shows member name, engine and Session; cancellation expires the corresponding request only.

Start with fresh member context containing role, initial task and logged team policy. Add native same-engine fork only after validating `forkSession` behavior with the pinned SDK, copied Session ledger and separate child native binding. Cross-engine context transfer uses an explicitly recorded context package, not native fork.

Claude CLI native Agent Teams cannot be assumed available in SDK sessions: official documentation states SDK/non-interactive sessions do not spawn native teammates. Harness-managed teammates therefore remain independent SDK sessions. SDK-defined internal subagents may be shown as subordinate native activity, but are not Team members unless explicitly adopted through a separate lifecycle design. [Official Agent Teams documentation](https://code.claude.com/docs/en/agent-teams), [SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).

<a id="codex"></a>

## Codex integration

Prefer app-server dynamic tools for the Team facade: advertise experimental capability when required, send names/descriptions/input schemas during thread creation, handle `item/tool/call`, and return the native response format. Protocol support must be verified against pinned Codex 0.153.4 before implementation; latest documentation alone is insufficient. An authenticated member-scoped MCP bridge is the fallback transport if dynamic tools are unavailable, selected explicitly with visible diagnostics.

On resume, validate the persisted tool set against the current facade version; do not accidentally restore stale tools from rollout metadata. Persist the advertised definitions and version in Harness logs. Unknown native server requests return protocol errors; they must not be accepted as approvals. [App-server dynamic tools](https://developers.openai.com/codex/app-server).

Reuse private per-Session Codex homes, model catalog, credential injection and thread resume. Profiles choose a distinct route/model per member. Model-only changes reuse the current process when its signature permits; vendor/startup metadata changes restart and resume the same member thread. Do not place members on the user’s active CLI home.

Optional live message delivery uses `turn/steer` with `expectedTurnId`; persist delivery intent before RPC and acceptance after success. A turn-completion race returns the message to next-turn scheduling without duplicating a possibly accepted steer. Transport loss after dispatch is uncertain and blocks automatic retry. Model/provider overrides cannot be sent through steer.

Optional native fork uses `thread/fork` at a completed turn. Forking across member private homes needs an owned export/import or supported path mechanism; verify it before advertising fork, and never share SQLite/auth/config to make it work. Initial release can use fresh/context-package modes. Internal Codex agents remain subordinate observations, not automatically adopted persistent Harness members.

<a id="persistence"></a>

## Shared services and persistence

Keep Team business logic in plugins: a member runtime service, execution-profile resolver and external Team tool facade. Add shared kernel operations only for engine-independent durable input delivery, selected Agent construction and optional live-input/fork capabilities. Do not put Team roster or tasks into AgentLoop.

New durable data must identify execution kind, profile ID/version, resolved selection, permission reference, workspace and child Session ID. Store profile definitions or the resolved model-visible policy where reconstruction requires them. Preserve old member records through declared read compatibility; acknowledge persistence changes and update generated schemas plus TypeScript/Python projections. Exact event names and format version are determined by the persistence review, not by this proposal.

All model-visible team policy, context packages, bridge tool schemas, calls/results and peer inputs must be reconstructable from Session records. Record reference IDs rather than secrets. Distinguish user-authorized work from peer requests; a teammate message must not grant authority to send external communications or elevate permissions.

Use configured member/process limits, lazy resume and idle eviction. One Session has one runtime owner in the supported single Harness process; cross-process Team writers remain unsupported. Persistent wake-on-input must not depend on an in-memory callback. Existing native storage isolation separates state, not filesystem edits or endpoint quotas.

Team UI adds engine/provider/model/profile, running/queued/loading/approval state, last turn outcome and recovery errors; users open the same member Session to inspect history and continue. Permission changes are explicit and bounded by the configured team policy. Worktree isolation, remote members, nested teams and shared-file locks are separate extensions.

<a id="gaps"></a>

## Engine capabilities outside Harness

Engine capability does not imply availability in the pinned build or compatibility with a third-party endpoint. Verify the official protocol/type and run a focused fixture before enabling each capability. The following inventory distinguishes known native features from proposed Harness adapters.

| Engine | Native feature | Current Harness gap / planned treatment |
|---|---|---|
| Claude SDK | Programmatic internal agents: prompts, tool/model restrictions. | Only common model aliases are configured; add native-agent definitions and subordinate UI separately. |
| Claude SDK | In-process MCP tools. | Main adapter does not bridge Team tools; this design adds a scoped server. |
| Claude SDK | Native session fork; background task start/progress/completion and task controls visible in installed types. | Driver declares fork unsupported and lacks a unified background-task lifecycle; verify pinned semantics before adding. |
| Claude SDK | Hooks and file checkpoints. | No Team lifecycle mapping or atomic Team-wide rollback; checkpoint integration is separate. |
| Claude CLI | Native interactive agent teams. | SDK sessions do not spawn native teammates; cannot implement by only setting an env flag. |
| Codex app-server | Dynamic tools and native tool-call RPC. | Current wire does not dispatch Team tool calls; add version-checked bridge. |
| Codex app-server | Live steer and native thread fork. | Both unsupported by current driver; implement separate logged capability paths. |
| Codex app-server | Thread read/rollback, history injection and review mode. | No coordinated Team history/rollback/review operations; rollback must not erase durable peer receipts. |
| Both | Native internal delegation/subagents. | Not represented as independent persistent Harness Team members; adoption needs distinct identity, messaging and recovery design. |

<a id="implementation"></a>

## Implementation packets and acceptance

| Packet | Owners / edit entry | Completion criteria |
|---|---|---|
| A: Profiles | `experimental/agent-team` types/config; Team settings UI; `tool-agent-team` discovery/spawn schema | Resolved selections persist; invalid/ambiguous/forbidden profiles reject; edits do not change existing members. |
| B: Persistent members | `agent-team/src/{roster,lifecycle}.ts`; proposed member-runtime provider; shared Agent construction | Create, close, cold-load and wake the same Session; preserve legacy members and recover provisioning. |
| C: Mailbox | `agent-team/src/mailbox.ts`; shared inbox/admission and engine ledger | No mandatory steer; busy queue, idempotent receipts, crash windows and uncertain native delivery are covered. |
| D: Claude tools | Claude `src/{engine,main-adapter}.ts`; proposed shared Team tool facade | All Team tools work through SDK MCP with exact caller identity, durable results and cancellation. |
| E: Codex tools | Codex `src/{engine,main-wire,main-adapter}.ts`; same facade | Pinned dynamic-tool protocol or explicit MCP transport; resume tool version and error paths verified. |
| F: UI and policy | `experimental/client-ui-agent-team`; session-controller projections; interaction services | Mixed-engine roster, scoped approvals, idle selection changes and visible recovery diagnostics. |
| G: Optional capabilities | Engine capabilities + steer/fork implementations | Advertise only validated support; cross-home fork and delivery races covered. |

Each packet updates its package README, bilingual design and owner-local expectations. Kernel changes also update architecture; durable schema changes update subsystem/persistence documentation and both SDK consumers. Keep production registration on engine `./startup` and avoid changing one-shot delegation behavior accidentally.

Acceptance matrix: native/Claude/Codex teammates under native Lead; external Leads after bridging; same and different provider/model combinations; fresh/context-package and validated same-engine fork; idle/busy/cancelled/cold-resumed members; concurrent approvals; interrupted wait; config/profile change; unknown tool; missing rollout; duplicate message; crash before/after target receipt; native submission uncertainty. Verify task revision conflicts and Lead-only authorization.

Plan deterministic unit and recorded-session fixtures first; paid real acceptance is a later explicitly authorized step. Use isolated test homes/processes and the configured compatible endpoints, never the active user Codex process. No runtime implementation or tests are performed by this design document.

## References

- [Current multi-engine implementation](../../main-agent-engines.md); [Team service](../../../packages/experimental/agent-team/README.md); [Team tools](../../../packages/experimental/tool-agent-team/README.md).

- [Claude SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents); [Claude SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools); [Codex app-server](https://developers.openai.com/codex/app-server). Official documentation may describe versions newer than the pinned dependencies.
