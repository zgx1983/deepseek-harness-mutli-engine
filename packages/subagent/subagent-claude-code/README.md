---
description: "The one-shot Claude Code subagent provider for users and maintainers choosing a product backend, installing a Profile bundle, or configuring an unattended Claude Code delegation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-claude-code

English | [中文](README.zh.md)

The `/startup` Cordis entry registers the Claude Code main conversation engine with `agents`, `llm`, `credentials`, and `subprocess` injected. Its deployment fields include `provider`, `model`, `env`, `pathToClaudeCodeExecutable`, and `disposeGraceMs`. The main entry does not register a subagent provider.

## Summary

Install this Profile Bundle when a delegated task should run as a fresh, unattended Claude Code session in the parent workspace. Each run accepts one self-contained text task and returns the final answer or a safe failure diagnostic; reasoning, tool traffic, stderr, usage, and workspace diffs stay out of the parent Session. Native Claude settings and authentication remain authoritative, while Profile configuration selects the model, environment, and `permissionMode`. The platform-pinned runtime starts on demand and never falls back to the host `claude` executable. Choose it when isolation and genuine Claude Code behavior matter more than continuation or prompts.

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

Mount this provider when a delegation should run as a real Claude Code session in the parent's workspace. The common path is explicit: install the Bundle into a Profile, optionally configure the provider row, and expose it to the model through a delegation tool row.

### Installing the Bundle

Install the package into the target Profile, then restart that Profile. The installation brings the pinned Agent SDK and one compatible platform CLI payload into the Profile; the declared patch layer registers only the dormant provider and starts no Claude process.

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
dsh --profile <name>
```

Removing the package withdraws the provider and its private runtime closure on the next Profile start. Installation controls Host availability, not model permission: the model can only reach the provider through a delegation tool row you compose.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `claude-code` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `model` | native Claude settings | Optional non-empty model name fixed for every run from this provider instance; omission sends no SDK override |
| `env` | `{}` | Explicit SDK/CLI environment layered over the credential-scrubbed parent environment |
| `permissionMode` | native settings | Explicit native non-interactive permission mode fixed for every run from this provider instance; omission delegates mode resolution to native settings |
| `disposeGraceMs` | `3000` | Grace between the shared managed-range owner's termination tiers |

| `permissionMode` value | Native behavior |
|---|---|
| omitted | Resolve the mode from native settings (`defaultMode` and rule lists) |
| `dontAsk` | Deny operations that are not already authorized instead of prompting |
| `acceptEdits` | Accept file edits; any remaining permission prompt is denied by the unattended callback |
| `auto` | Let Claude Code's native classifier allow or deny permission requests |
| `plan` | Run in native planning mode, deny execution approval, and return the completed plan as the final answer |
| `bypassPermissions` | Explicitly set the SDK's dangerous confirmation and bypass permission checks |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-claude-code) is the exhaustive source for every accepted field and its JSDoc. A configured `model` passes unchanged to every query from that provider instance; omission leaves native model selection in force. Credential-shaped ambient variables are removed before the explicit `env` overlay, so an API key intended for the child must be supplied there. The provider omits the SDK `settingSources` option, so Claude Code reads the host's normal user, project, and local settings relative to the parent Session cwd. It does not copy or filter those files, create or modify login state, inspect `PATH`, or fall back to a host `claude` executable.

### Main-engine endpoint resolution

The exported main-engine factory reads the selected session provider, or the deployment provider override when none is selected. Without either, exactly one route must advertise `anthropic-api`; missing or ambiguous routes fail before startup. The factory resolves the route’s credential reference through the credential service and uses the selected session model before the deployment default. Claude receives `ANTHROPIC_BASE_URL` and, when configured, `ANTHROPIC_AUTH_TOKEN`. Explicit engine environment entries override injected values. The bundle’s `apply()` continues to mount the one-shot subagent provider; using the main factory requires separate engine registration.

### Exposing the tool

Each delegation tool row names one provider and needs its own `toolName`, so the model sees static tools rather than a dynamic provider selector. Full Agent Presets carry a matching default tool row with `disabled: true`; copy a preset and remove that field to expose `subagent_claude_code` only to agents composed from the copy.

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-claude
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

The `one-shot` policy keeps omitted or `false` `run_in_background` calls in the foreground, while explicit `true` returns a parent-owned job id for `job_output` or `job_kill`; the base host and full presets already provide the generic Job registry and controls.

### What you get

A foreground call gives the model the strict final Claude Code answer, or an error with the stop reason and optional safe diagnostic for a failed run. A background call first returns a job id; the generic job controls later deliver a completion notice and expose the same final answer or failed status through `job_output`. Claude Code reasoning, tool activity, intermediate messages, stderr, and workspace diffs never enter the parent session.

### Failure and recovery

An install that omits optional dependencies, uses an unsupported platform, or loses the selected payload leaves the provider dormant and fails the first delegation at the SDK startup boundary with a safe `query-start` / `unknown` failure fact; there is no host-CLI fallback. The original product error stays on the internal cause chain and in the provider's Host log. A cancelled run settles as `aborted`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the provider drives a real Claude Code CLI and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One fresh query per run.** Every run has an independent SDK query, cancellation controller, CLI process, and non-persisted product session; there is no continuation, resume, or pooling.
- **Native settings are authoritative.** The provider deliberately omits the SDK `settingSources` option, so Claude Code reads the host's normal user, project, and local settings; an optional `model` and an optional explicit `permissionMode` are the only query-level overrides.
- **Unattended by design.** `AskUserQuestion` is disabled and permission prompts are denied except in bypass mode, so the query never waits for a user interface.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/run.ts`](src/run.ts) | The SDK query lifecycle, result acceptance, and permission handling |
| [`src/process.ts`](src/process.ts) | Managed-range termination escalation on disposal |
| [`tsdown.config.ts`](tsdown.config.ts) | Independent bundles for the provider and main-engine entries; published files need no shared chunks. |
| [`cordis.patch.yml`](cordis.patch.yml) | The Profile patch layer that registers the dormant provider |

### Run flow

A start accepts only a non-empty sequence of text blocks and derives the child cwd from the parent session. It creates a private `AbortController`, calls the official SDK `query()` with the exact concatenated task, and publishes the run only after the SDK's custom-spawn hook has supplied a live CLI handle owned by the subprocess seam. The provider iterates the complete message stream and accepts only a `result` message with `subtype: "success"`, `is_error: false`, and a nonblank `result`, followed by normal iterator completion. Every other outcome maps to a fixed-category `error` diagnostic naming the lifecycle stage and observed process outcome — the category set lives in [`src/run.ts`](src/run.ts). Local cancellation wins the result race and maps to `aborted` without a failure diagnostic.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this provider to the seam it plugs into and the sibling product provider.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [Codex subagent provider](../subagent-codex/README.md) — the sibling product backend over the official app-server protocol.
- [Claude Code and Codex backends](../../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md) — the design record for the product providers.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-claude-code) — every accepted config field and its source declaration.

-----

## Main conversation execution

The main composer lists commands reported by the selected Claude SDK session. Prompt commands are submitted as ordinary, durable Session messages so the CLI executes them in its own conversation; changing the Session engine or model refreshes that command list. SDK `commands_changed` messages also invalidate the client directory. Image attachments are read from the authorized attachment store and sent as Anthropic image blocks. Offloaded images use their text-only attachment notice, and generic files remain unsupported by this engine.

The `./startup` provider registers a main conversation driver independently of one-shot delegation. It reads the session provider/model/effort and `anthropic-api` endpoint before each turn. Harness API keys travel through `ANTHROPIC_API_KEY` and the endpoint through `ANTHROPIC_BASE_URL`; the native config directory is `$DSH_HOME/engines/claude`. A provider, endpoint, credential, model or effort change closes the previous CLI and awaits its exit before starting a new process with the resolved values on the next turn. A persisted native Session identity with a recorded input delivery is resumed without replaying DSH history. Command discovery before any input delivery starts a fresh native session: SDK initialization alone does not create resumable history. Settled turns report token usage and the served model's native context window, which the shared loop records for the composer statistics and context meter. The session permission preset is the only permission source: a policy that grants full access — the danger-full-access sandbox with never approvals — translates directly into the native `bypassPermissions` mode, and workspace write selects the native `acceptEdits` mode; every other policy keeps the native default prompt behavior. The engine never reads the host's `~/.claude/settings.json`, so host permission rules cannot restrict or redefine a session. The CLI loads all three native settings tiers as in a native run, and the engine mirrors the host's `~/.claude/CLAUDE.md` into its config home so user instructions apply while settings fields, credentials, and sessions stay isolated; the `project` and `local` tiers also activate repository settings, skills, and hooks exactly as the native CLI does. A host without `~/.claude/CLAUDE.md` contributes no mirrored instructions, so the session keeps native defaults.

Session permission presets select the native permission mode — full access with never approvals becomes native bypass, workspace write becomes native edit acceptance, and every other policy keeps the native default — and presets still control the native sandbox, the read-only tool whitelist, and approval routing. A changed preset reconciles on the prepared process through the SDK control requests (`setPermissionMode`, and `applyFlagSettings` for the sandbox block) instead of restarting the CLI: the new sandbox block governs every command that starts afterwards. A native mode the process was not launched to allow (entering bypass without the start-time grant) is refused, which rebuilds the process so the policy still takes effect; plan mode and a changed read-only tool whitelist keep that restart path too. Native permission prompts route to the session's approval service through `canUseTool`, which reads the effective session policy per call, while operations allowed by the selected native mode execute without a DSH approval record. Restricted presets require the native sandbox. Workspace-write with Ask permits an unsandboxed retry only through native permission review; other restricted policies disable that retry. Read-only exposes only Read, Glob, Grep and AskUserQuestion. Permission and question replies expire with their owning turn.

Main conversations resolve `pathToClaudeCodeExecutable` through the subprocess provider when configured; invalid explicit values fail before message admission. Otherwise they look up `claude` on PATH, then `~/.npm-global/bin/claude`, and use the SDK payload only when both are absent. Resolution happens when preparing a new CLI process; an existing process keeps its executable. The selected host CLI must support the pinned SDK protocol. One-shot delegation continues to use its pinned runtime.

For main conversations, provider model metadata supplies `CLAUDE_CODE_MAX_CONTEXT_TOKENS` with the full context capacity and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` with 90% of that capacity. The model name is forwarded unchanged. When metadata omits a capacity, both variables are omitted, including deployment and inherited values. These settings tell Claude Code the gateway model’s capacity and compaction threshold; they do not expand the provider model’s capacity. `env.CLAUDE_CODE_EFFORT_LEVEL` remains an explicit deployment setting and is not set automatically.

MCP elicitation uses the same turn-owned question service: primitive forms support strings, numbers, integers, booleans and enumerated string arrays; answers are validated against the requested JSON Schema. HTTP(S) URL requests show the link and wait for explicit confirmation without opening a browser or claiming authentication succeeded. Password, write-only, nested and unsupported schemas are declined. Generic SDK dialogs remain disabled because this integration has no dialog-specific renderer.

Native tool input and progress updates appear in observational cards. `activityUpdateIntervalMs` defaults to 100 milliseconds between progress records per tool; terminal tool records remain immediate, and `maxActivityCharacters` bounds streamed arguments. A dead idle CLI is resumed at the next preparation with the same persisted native identity. A dispatched turn that reaches no terminal native settlement settles as `acknowledged-uncertain`, recorded by the failing turn or by the next preparation after a writer crash; the input is never resent. A failed observation stream terminates its managed CLI and awaits exit. Nested-agent transcript frames stay out of the main answer, and native results with an explicit input UUID must match the admitted turn. Native result errors retain their diagnostic text through credential redaction.

The main-engine `providers` dictionary maps registered LLM routes to `opusModel`, `sonnetModel`, `haikuModel` and `subagentModel`. These populate `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` respectively. Each omitted field uses the explicit deployment environment value, then the session-selected model; ambient host aliases cannot route internal work to an unrelated model. Mapping changes replace the CLI before the next turn. The main model remains the exact configured catalog id, including `[1m]`; aliases do not add models to the Harness catalog.

## Native child status

Main-engine child observations consume `task_started`, `task_progress`, `task_updated` and `task_notification` before checking foreground-turn ownership. `Agent` and legacy `Task` calls establish child identities; messages with `parent_tool_use_id` update child output rather than the parent transcript. Non-agent and ambient background tasks are excluded. Native completion, failure and stopping update the corresponding record; SDK stream loss marks unfinished children unknown. `maxActivityCharacters` bounds child text. Observation does not enable direct child-session prompts or standalone child interruption, and older SDK streams lacking lifecycle notifications may leave a child unconfirmed.

Foreground Agent/Task results settle child status; structured async launch results remain running. A background task completion received between parent turns queues one durable tool-sourced completion message and wakes the parent on the same native session. Completion during an active turn is left to that native turn; stopping or replacing the process does not synthesize completion.

Main-engine `providers[provider].reasoningEfforts` maps selectable ids to SDK values (`low`, `medium`, `high`, `xhigh`, `max`) or null for `thinking: {type: "disabled"}`. `defaultReasoningEffort` names a selectable default, and `models[exactModelId]` overrides either field. Without overrides, compatible adapter protocol mappings and defaults are inherited; unsupported SDK values are excluded from the menu and rejected if explicitly selected. The mapped effort and thinking mode participate in process replacement and native resume. See [configuration example](../../../docs/main-agent-engines.md#engine-reasoning-mapping).

The `./startup` entry also registers `engine:claude` when the subagent service is available. This session-backed provider supports continuable children through the main-chat Claude driver: durable history, activity cards, native identity, human interaction, cancellation, and later turns. The package-root one-shot provider retains its separate unattended configuration and behavior. Child vendor/model/effort values come from delegation Agent options and configured provider endpoints.

With the user setting source enabled, main sessions merge `~/.claude/skills` and `$DSH_HOME/skills` into `$DSH_HOME/engines/claude/skills` using directory links; the native global root wins duplicate folder names. Project `.claude/skills` remains native workspace discovery under the project setting source. Existing real folders and unrelated links are preserved, and stale managed links are removed at preparation. Source edits remain visible without copying skill bodies.

Claude local command output and informational messages are persisted as native activity cards. `/plan` toggles the native plan permission mode on the live query: entering switches the SDK permission mode to `plan`, `off` restores the session-policy mode (`default` when the policy selects the native default), and each acknowledged switch is recorded in the Session log so a restarted adapter re-applies it. Compaction status and `compact_boundary` update one operation, retaining native token metadata and failure details. A successful result without assistant text displays its native result once; a skipped compaction displays the native reason rather than claiming compression completed. Harness model and permission controls retain ownership. Native `clear`, `reset`, `resume`, `rewind`, `fork`, `exit`, and `quit` commands are hidden and rejected until their session rebinding is supported.

Main conversations with scoped Harness Team tools connect to a process-owned `dsh_team` HTTP MCP server through SDK `mcpServers`. Those tools are explicitly allowed at the native permission layer and still traverse Harness tool policy and Team authorization. `teamToolTimeoutMs` configures the native MCP deadline (default 3,660,000 milliseconds). The driver recreates the connection on cold resume or process restart and drains outstanding calls when a turn ends.

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The Claude Code child receives the standalone text task as one fresh SDK query. Its workspace is the parent Session cwd; the selected provider instance fixes the query's configured model, environment, and non-interactive permission mode, while an omitted model and every other product setting come from native Claude configuration. The executable version comes from the Bundle's pinned SDK platform payload.

#### Token effect

The child pays for an independent Claude Code context and query. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Claude Code's own model, instructions, tools, native settings, and fresh query.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent the strict final Claude Code answer or an error containing the stop reason and optional safe diagnostic for a non-completed result. That diagnostic can distinguish a coarse action category, lifecycle stage, and observed process outcome without copying raw product text or version-specific subtype names. A background call first returns a Job id; the generic job controls later deliver a completion notice, expose the same final answer or failed status detail through `job_output`, and let `job_kill` request cancellation. Claude Code reasoning, tool activity, intermediate messages, stderr, workspace diffs, usage, product ids, tool inputs, and raw protocol payloads are not copied into the parent Session.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the start acknowledgement, completion notice, and any `job_output`, `job_kill`, or later status results; child tokens still do not enter the parent context. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the Job acknowledgement, notice, and later control or collection results. Background scheduling can add a notice-driven turn, but none of these messages rewrites the earlier prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this provider is a poor fit or needs special operational care. They are current package constraints, not a general Claude Code comparison or a task backlog.

- **One fresh query and process per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Static instance selection** — Profile rows fix provider names, optional models, and tool bindings; calls cannot choose or change either a provider or model dynamically, and every exposed tool needs a unique `toolName`.
- **Host settings are intentionally authoritative** — when `model` is omitted, project and user settings choose it; native settings always retain the remaining tools and behavior, and the provider does not provide a filtered or hermetic production mode.
- **Authentication and account state remain native** — the Bundle supplies the CLI but does not create an account, log in, or rewrite Claude settings; configuration and authentication failures surface with their lifecycle stage and the safe `unknown` fallback rather than a separate public classification.
- **The SDK platform payload is required at delegation time** — installs that omit optional dependencies, unsupported platforms, and missing or damaged payloads fail at the first query; there is no host-CLI fallback.
- **No human interaction path** — `AskUserQuestion` is disabled, permission prompts are denied, MCP elicitation is declined, and blocking dialogs fail closed instead of suspending.
- **Assistant payload is final text only** — reasoning, intermediate messages, tool traffic, usage, stderr, and workspace diffs remain product-local.
- **No optional shared capabilities** — `agentOptions`, output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.

<a id="dev-note"></a>

After successful preparation, the engine records its resolved provider and model selection in the Session for the model-selector projection. External engines without a native request/header therefore do not display the catalog default instead of the selected model.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Payload size disclosure** — the current darwin-arm64 platform payload packs to about 92 MB and unpacks to about 325 MB; these are disclosure numbers, not installation thresholds.
- **Version-pinned protocol** — the runtime dependency is pinned to Agent SDK 0.3.263; upgrading pins a new SDK version and requires re-running the keyless real-product and loader-composition evidence.

</details>

**Runtime invariant:** No companion is published. Lifecycle pairing belongs to the shared subagent service, and managed-range ownership belongs to the subprocess service.
