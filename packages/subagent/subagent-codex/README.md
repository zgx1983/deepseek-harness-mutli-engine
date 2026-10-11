---
description: "The one-shot Codex subagent provider for users and maintainers choosing a product backend, installing a Profile bundle, or configuring an unattended Codex delegation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-codex

English | [中文](README.zh.md)

The `/startup` Cordis entry registers the Codex main conversation engine with `agents`, `llm`, `credentials`, and `subprocess` injected. Its deployment fields are `provider`, `model`, `env`, `mirrorUserInstructions`, `projectDocFallbackFilenames`, `autoCompactContextRatio`, `permissionMode`, and `disposeGraceMs`. The main entry does not register a subagent provider.

## Summary

Install `@deepseek-ai/dsh-subagent-codex` into a Profile when delegated work should run in a genuine, unattended Codex session in the parent Session's workspace. Each delegation uses a fresh isolated Codex thread for one self-contained text task and returns only its final answer or a safe failure diagnostic. Native Codex configuration and authentication remain authoritative, while `permissionMode` selects the non-interactive approval and sandbox behavior. The Bundle supplies a compatible native Codex payload, but it exposes no model capability until a delegation tool is configured.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider when a delegation should run as a real Codex session in the parent's workspace. The common path is explicit: install the Bundle into a Profile, optionally configure the provider row, and expose it to the model through a delegation tool row.

### Installing the Bundle

Install the package into the target Profile, then restart that Profile. The installation brings the official wrapper and one compatible native platform payload into the Profile; the declared patch layer registers only the dormant provider and starts no Codex process.

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh --profile <name>
```

Removing the package withdraws the provider and its private runtime closure on the next Profile start. Installation controls Host availability, not model permission: the model can only reach the provider through a delegation tool row you compose.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `codex` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `model` | native Codex settings | Optional non-empty model name fixed for every thread from this provider instance; omission sends no app-server override |
| `env` | `{}` | Explicit child environment layered over the credential-scrubbed parent environment |
| `permissionMode` | `never` | Native non-interactive approval and sandbox mode fixed for every thread from this provider instance |
| `disposeGraceMs` | `3000` | Grace between the shared managed-range owner's termination tiers |

| `permissionMode` value | `thread/start` fields | Native behavior |
|---|---|---|
| `never` | `approvalPolicy: never`; sandbox omitted | Never ask for approval; execution failures return to the model under the native sandbox |
| `approve-for-me` | `approvalPolicy: on-request`, `approvalsReviewer: auto_review`, `sandbox: workspace-write` | Route permission requests through Codex automatic review without a human |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`, `sandbox: danger-full-access` | Skip approval and sandbox enforcement; this value must be selected explicitly |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-codex) is the exhaustive source for every accepted field and its JSDoc. A configured `model` passes unchanged on each ephemeral `thread/start`; omission leaves native model selection in force. The provider does not discover models, rewrite aliases, select `modelProvider` or `serviceTier`, or set a fallback. Credential-shaped ambient variables are removed before the explicit `env` overlay, so an API key intended for the child must be supplied there.

### Main-engine endpoint resolution

The exported main-engine factory reads the selected session provider, or the deployment provider override when none is selected. Without either, exactly one route must advertise `openai-compatible`; missing or ambiguous routes fail before startup. The factory resolves the route’s credential reference through the credential service and uses the selected session model before the deployment default. Codex receives a private `model_providers.dsh_engine` configuration and the resolved key through `DSH_CODEX_API_KEY`; secrets do not enter command arguments. Explicit engine environment entries override injected values. The bundle’s `apply()` continues to mount the one-shot subagent provider; using the main factory requires separate engine registration.

### Exposing the tool

Each delegation tool row names one provider and needs its own `toolName`, so the model sees static tools rather than a dynamic provider selector. Full Agent Presets carry a matching default tool row with `disabled: true`; copy a preset and remove that field to expose `subagent_codex` only to agents composed from the copy.

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
```

The `one-shot` policy keeps omitted or `false` `run_in_background` calls in the foreground, while explicit `true` returns a parent-owned Job id for `job_output` or `job_kill`; the base host and full presets already provide the generic Job registry and controls.

### What you get

A foreground call gives the model the selected final Codex answer, or an error with the stop reason and optional safe diagnostic for a failed run. A background call first returns a Job id; the generic job controls later deliver a completion notice and expose the same final answer or failed status through `job_output`. Codex commentary, reasoning, tool activity, raw stderr, and workspace diffs never enter the parent session.

### Failure and recovery

An install that omits optional dependencies, uses an unsupported platform, or loses the selected payload leaves the provider dormant and fails the first delegation at `initialize` with a safe `unknown` category and any observed process outcome; there is no host-CLI fallback. Raw wrapper text stays on Host stderr. A cancelled run settles as `aborted`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the provider drives a real Codex app-server and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One fresh process, thread, and turn per run.** Every run spawns a fresh app-server, creates one ephemeral thread, and executes exactly one turn; there is no continuation, resume, or pooling.
- **Native configuration is authoritative.** Codex configuration and authentication stay native through the parent cwd, `HOME`, and `CODEX_HOME`; the provider overrides only the optional model and the thread's approval, reviewer, and sandbox fields.
- **Unattended by design.** Approval, user-input, and MCP requests are answered or declined without a human; unknown server requests fail the run.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/run.ts`](src/run.ts) | The run lifecycle, turn execution, result selection, and diagnostics |
| [`src/wire.ts`](src/wire.ts) | The minimal app-server JSON-RPC wire implementation |
| [`tsdown.config.ts`](tsdown.config.ts) | Independent bundles for the provider and main-engine entries; published files need no shared chunks. |
| [`cordis.patch.yml`](cordis.patch.yml) | The Profile patch layer that registers the dormant provider |

### Run flow

A start accepts only a non-empty sequence of text blocks and derives the child cwd from the parent session. It spawns the fixed command through the subprocess seam, performs the `initialize` → `initialized` handshake, maps the Profile-selected mode and optional model into official `thread/start` fields beside `{ cwd, ephemeral: true }`, and publishes the run only after Codex returns a valid ephemeral thread. The published result starts exactly one turn, accepts only notifications for that run's thread and turn, and waits for the authoritative `turn/completed` terminal. The latest `agentMessage` with `phase: "final_answer"` wins; when Codex emits no explicit final phase, the latest message with `phase: null` is the compatibility fallback. A successful turn with no nonblank answer settles as an error. Failed turns use the coarse categories `limit`, `access-policy`, `service`, `transport`, `product-error`, `invalid-result`, or `unknown`; an early app-server exit uses `process`, and applicable connection and stream failures retain a numeric `httpStatusCode`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this provider to the seam it plugs into and the sibling product provider.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [Claude Code subagent provider](../subagent-claude-code/README.md) — the sibling product backend over the official Agent SDK.
- [Claude Code and Codex backends](../../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md) — the design record for the product providers.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-codex) — every accepted config field and its source declaration.

-----

## Main conversation execution

The composer lists mapped Codex operations and enabled workspace skills discovered through `skills/list`. `/compact` calls `thread/compact/start` and waits for its terminal turn notification. `/review [instructions]` enters the durable input lane and calls inline `review/start`; omission reviews uncommitted changes, and arguments supply custom instructions. Reviewer output streams into the main conversation. A skill command becomes a `$name` text marker plus its exact native `skill` input path in `turn/start`. Disabled skills are excluded and duplicate names fail discovery. Skill invocation paths are recorded as `engine/item-settled` command-catalog metadata before use. Thread-native operations apply changed model and effort settings through `thread/resume` before execution; ordinary skill turns carry the current turn overrides. Codex slash parsing remains a TUI feature; unsupported CLI commands are not advertised. When the app-server advertises `collaborationMode/list`, `/plan` records the native collaboration mode and every subsequent `turn/start` carries `{ mode, settings: { model, reasoningEffort? } }`, so the mode applies from the next turn and `off` returns to `default`; a build without that surface omits the command and rejects `/plan` with an explicit unsupported reason. Native `skills/changed` notifications invalidate the client directory. Image attachments are read from the authorized attachment store and passed to `turn/start` as data URLs, so the server receives image bytes without access to the private attachment path. Offloaded images use their text-only attachment notice; generic files remain unsupported by this engine.

The `./startup` provider registers a persistent interactive main conversation driver independently of one-shot delegation. It passes the selected provider Responses URL, credential environment reference, model and effort into the pinned Codex app-server. The selected model's resolved context window also travels as `model_context_window`, and `model_auto_compact_token_limit` derives from it through deployment `autoCompactContextRatio` (default `0.9`, matching the Claude engine), so a custom Responses route compacts on the same window the session reports; route configuration or an exact-model override pins either value, and a model with no known window leaves both to native defaults. One shared app-server child serves every ordinary session: it initializes at process startup, and each conversation attaches to it as a native thread, so many conversations cost one child process instead of one per session. The shared child carries one native home at `$DSH_HOME/engines/codex/shared-home` with shared SQLite and log directories; older rollouts migrate read-only from the legacy root and from a session's former per-session home, so committed generations are copied, never moved. Resume validates native identity and workspace, then supplies the exact rollout path. Legacy shared storage contributes only the matching rollout file; databases, authentication, configuration and unrelated histories are never copied. Missing history with accepted messages fails instead of starting a fresh thread. Text, reasoning, usage and native command/file activity project into the shared conversation stream. Token-usage notifications also carry the native context window when the runtime reports it; until then the prepared model catalog's resolved context window stands in. Deployment `permissionMode` remains a legacy adapter setting; managed main conversations translate the effective session permission preset directly into native thread permissions, and the engine never reads the host's `~/.codex/config.toml` or `~/.codex/rules`, so host permission fields cannot restrict or redefine a session. Before each preparation the engine mirrors the host's `~/.codex/AGENTS.md` into the home so native global instructions load as they do for a direct CLI run; deployment `mirrorUserInstructions: false` disables the mirror. Project `AGENTS.md` files resolve from the workspace unchanged, and the app-server receives `project_doc_fallback_filenames` so a workspace documented only in `CLAUDE.md` loads the same instructions; the deployment default is `CLAUDE.md`.

Sandbox maps directly to `thread/start` or `thread/resume` sandbox; human review uses `approvalPolicy: on-request` with `approvalsReviewer: user`, Never uses `never`, and Auto uses `on-request` with `auto_review`. The session permission preset is the only permission source and fixes every thread field: nothing in the host's `~/.codex/config.toml` or `~/.codex/rules/*.rules` reaches the session home, so a host config can neither restrict nor redefine the chosen access, and a session that grants full access always runs as `sandbox: danger-full-access` with `approvalPolicy: never`. Command/file/permission approvals and non-secret user questions return correlated replies to their owning native turn. Unknown interactions fail closed.

The main-engine `providers` dictionary is keyed by the registered LLM route. It accepts `httpHeaders`, `headerCredentialRefs`, `queryParams`, retry and stream timeout settings, `supportsWebsockets`, model context/compaction/reasoning-summary/verbosity metadata, and exact-model overrides under `models`. Header credentials resolve before replacing a process and travel only in child environment variables. `subagentModel` and `subagentReasoningEffort` become native `agents.default_subagent_model` and `agents.default_subagent_reasoning_effort`; they select Codex internal subagents, independently of Harness delegation. Main model selection remains session-owned and is passed through thread and turn RPC fields.

A model-only change with identical route and thread settings stays on the shared thread, updating `turn/start.model`. A provider switch between registered routes, or a permission change, reattaches the thread through `thread/resume` under the new native values. Configuration or credential drift restarts the shared child between turns and every session reattaches; a change colliding with an in-flight native turn fails loudly until that turn settles. Conversations with Harness Team tools keep a dedicated per-session child with per-session replacement semantics. The Harness model catalog supplies the `/model` picker and the native catalog.

Each shared-child start resolves the models served by every registered route's Responses endpoint and merges the routes' catalogs into one `models.json`, written atomically in the shared native home and passed by absolute path through `model_catalog_json`; a model id served by two routes fails the start. Context, reasoning levels and modalities come from live LLM metadata when available; an unlisted selected name with unavailable metadata uses that name as its catalog id and display name. Route and exact-model configuration override native context, compaction, summary and verbosity fields in the catalog. Earlier selected unlisted names remain in the shared catalog per route, refreshing its metadata without a child restart. Initialization checks native `model/list`, including pagination, for every expected id once at child startup; a missing id or unavailable provider catalog fails the start.

`catalogInstructions` supplies the generated catalog’s coding instructions, and `catalogTruncationTokenLimit` defaults to 10,000 tool-output tokens. Route or exact-model `modelInstructions` and `modelTruncationTokenLimit` override those defaults. The acknowledged catalog is recorded as an `engine/item-settled` item with category `model-catalog` before any prompt, so coding instructions remain reconstructable from the Harness Session; native rollouts also retain the effective instructions. Generated directories contain no endpoint credentials and never modify the user’s global Codex configuration.

## Native child status

The main wire recognizes current `collabAgentToolCall` and legacy `collabToolCall` items, records receiver identities and reported agent states, and routes known child-thread notifications before parent-thread filtering. A completed spawn/wait tool call is not itself child completion. Resume reconstructs receiver relationships from available native thread items and treats historical unfinished states as unknown. Known child approval/question requests use the owning process lifetime; unrelated threads remain rejected. Child output uses `maxActivityCharacters`; `activityUpdateIntervalMs` controls output observation frequency (default 100 ms). No extra app-server process, native polling loop or configuration-directory mutation is introduced. Child detail completeness depends on notifications published by the installed server version; direct child prompts and user-facing child controls remain unavailable.

Main-engine `providers[provider].reasoningEfforts` maps selectable ids to app-server effort strings; null maps to `none`. `defaultReasoningEffort` names a selectable default, and `models[exactModelId]` overrides either field. Without overrides, adapter protocol mappings and compatible defaults are inherited. `resolveCodexModelCatalog` uses mapped values for native supported/default reasoning levels and retains the same per-model mappings for preparation. The mapped value is passed as `effort` on every turn, and the dedicated team-session child also pins it as `model_reasoning_effort` at startup; reattachment preserves the bound native thread. These fields do not change `subagentReasoningEffort`. See [configuration example](../../../docs/main-agent-engines.md#engine-reasoning-mapping).

The `./startup` entry also registers `engine:codex` when the subagent service is available. It runs continuable children through the main-chat driver, giving each child its own durable Harness Session, isolated Codex home, native thread binding, streamed activity, approvals, questions, interruption, and cold resume. The package-root legacy one-shot provider remains separate. Delegation Agent options choose the child vendor/model/effort.

Main sessions merge `~/.codex/skills` and `$DSH_HOME/skills` into the isolated `$CODEX_HOME/skills` using directory links; the native global root wins duplicate folder names. Native project `.agents/skills` and user `~/.agents/skills` discovery remains available. Existing real folders and unrelated links are preserved, and stale managed links are removed at preparation. Source edits remain visible without copying skill bodies.

Compaction uses native activity records for progress and completion; it does not fabricate an assistant reply. Chat and Trajectory localize the `contextCompaction` operation. Failure and interruption settle remaining command activities before releasing the operation. Only mapped app-server commands and discovered enabled skills are exposed; CLI-only commands have no generic slash-command passthrough.

Main conversations with scoped Harness Team tools keep a dedicated per-session app-server child, because their per-agent `mcp_servers.dsh_team` Streamable HTTP connection needs a private process; ordinary sessions share the process-wide child. The bridge's authentication comes from a process environment header and is not persisted. `teamToolTimeoutMs` configures the MCP deadline (default 3,660,000 milliseconds); the connection is required at startup. Native MCP approval is explicit for this server; calls run with the owning Harness Agent through Harness tool policy and Team authorization, and turn settlement drains outstanding calls. Cold resume and provider restarts recreate the connection without replacing the native thread.

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The Codex child receives the standalone text blocks as one turn in a fresh ephemeral thread. Its workspace is the parent Session cwd; the selected Provider instance fixes any configured model, environment, non-interactive approval policy, and sandbox mode, while an omitted model and every other product setting come from native Codex configuration. The executable version comes from the Bundle's pinned platform payload.

#### Token effect

The child pays for an independent Codex context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Codex's own provider, model, instructions, tools, and ephemeral-thread request.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent the selected final Codex answer or an error containing the stop reason and optional safe diagnostic for a non-completed result. The diagnostic can distinguish a coarse action category, protocol stage, applicable numeric HTTP status, and observed process outcome without copying product prose or stderr. A background call first returns a Job id; the generic job controls later deliver a completion notice, expose the same final answer or failed status detail through `job_output`, and let `job_kill` request cancellation. Codex commentary, reasoning, tool activity, raw stderr, workspace diffs, usage, product ids, commands, paths, and protocol payloads are not copied into the parent Session.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the start acknowledgement, completion notice, and any `job_output`, `job_kill`, or later status results; child tokens still do not enter the parent context. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the Job acknowledgement, notice, and later control or collection results. Background scheduling can add a notice-driven turn, but none of these messages rewrites the earlier prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this provider is a poor fit or needs special operational care. They are current package constraints, not a general Codex comparison or a task backlog.

- **One fresh process, thread, and turn per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Static instance selection** — Profile rows fix provider names, optional models, and tool bindings; calls cannot choose or change either a provider or model dynamically, and every exposed tool needs a unique `toolName`.
- **Authentication and account state remain native** — the Bundle supplies the CLI but does not create an account, log in, trust a project, or rewrite Codex settings; configuration and authentication failures surface with their lifecycle stage and the safe `unknown` fallback rather than a separate public taxonomy.
- **The native platform payload is required at delegation time** — installs that omit optional dependencies, unsupported platforms, and missing or damaged payloads fail at the first run; there is no host-CLI fallback.
- **Compatibility is pinned by development evidence** — upgrading from the verified 0.153.4 protocol baseline requires regenerating upstream schema evidence and rerunning handshake, answer-selection, approval, cancellation, keyless real-product, and credentialed DeepSeek nonce tests.
- **No human approval path** — known unattended approval requests are denied and unknown server requests fail closed; the three Profile modes never create a DSH interaction channel or per-call allow policy.
- **Assistant payload is final text only** — a failed run may additionally expose the separate safe diagnostic; reasoning, commentary, intermediate messages, tool traffic, usage, raw stderr, and workspace diffs remain outside the parent Session, while generic Job ids, notices, and status come from the shared job runtime.
- **No optional shared capabilities** — `agentOptions`, output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.

<a id="dev-note"></a>

After successful preparation, the engine records its resolved provider and model selection in the Session for the model-selector projection. External engines without a native request/header therefore do not display the catalog default instead of the selected model.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Payload size disclosure** — the current darwin-arm64 platform payload packs to about 114 MB and unpacks to about 282 MB; these are disclosure numbers, not installation thresholds.
- **Version-pinned protocol** — the runtime dependency is pinned to `@openai/codex@0.153.4`; upgrading requires regenerating the upstream schema evidence and rerunning the credentialed nonce tests.

</details>

**Runtime invariant:** No companion is published. Lifecycle pairing belongs to the shared subagent service, and managed-range ownership belongs to the subprocess service.
