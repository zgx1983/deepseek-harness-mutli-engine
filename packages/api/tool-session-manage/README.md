---
description: "Model-facing project, engine, and model catalogs plus conversational session creation for deployments that let the model open new sessions in known projects."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-manage

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-session-manage` to let a model answer requests like "create a session in the alpha project with the codex engine and model glm-5". Three read-only catalog tools — `list_projects`, `list_engines`, and `list_models` — resolve spoken names into ids; `session_create` creates a user-visible Session in a registered project or an absolute directory, optionally fixing its engine, model, and title before the first user message. A matching blank Session already attached to the target project is adopted instead of a fresh create. The package ships enabled in the Web application.

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

Mount this package when the model should resolve project, engine, and model identities itself and open Sessions on the user's behalf. It calls the Host session and workspace services in-process, so it belongs to compositions that mount `dsh-api-session-controller` and `dsh-workspace` beside it — the shipped Web application does exactly that.

### When to choose it

Choose it when conversational session creation should work end to end: the catalog tools turn spoken names into ids, and `session_create` commits them. Avoid it for compositions without the Session controller or workspace registry (for example the headless profile); there the plugin cannot resolve its services.

### Configuration

The package accepts no configuration: every tunable choice (blank reuse, engine-relative model catalogs, error recovery guidance) is fixed behavior.

### What the model can do

| Tool | What the model gets |
|---|---|
| `list_projects` | Every registered project workspace: id, path, title, and session count |
| `list_engines` | Every engine a new Session may choose: id, name, and optional description |
| `list_models` | The deployment default plus provider-grouped models, optionally narrowed to one engine's routable providers |
| `session_create` | One created (or reused blank) Session id, plus the resolved engine, model, and title when requested |

### Failures and recovery

Argument pairing errors (workspace versus cwd, provider versus model) fail before any service call with `SESSION_MANAGE_INVALID_ARGS`. An unregistered workspace, engine, or model returns its `SESSION_MANAGE_*` code with the catalog tool to call next; unknown service failures collapse to `SESSION_MANAGE_TOOL_FAILED` and leave diagnostics in the Host log only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`list_*` read `ctx.workspaceRegistry.list()` and `ctx.sessionController.engineCatalog()` / `modelCatalog(engineId?)`, trimming entries to the fields a model acts on. `session_create` mirrors the Web client's blank-reuse predicate — blank, same canonical cwd, attached to the target workspace, not archived — then adopts that Session via an explicit-id `create`; adoption races (`session/writer-held`, `session/engine-conflict`, `session/conflict`) fall back to a fresh create. The engine is fixed through the create request before the first user message, so model selection and rename always run on an unlocked, idle Session.

A `serviceBoundary` wrapper preserves cancellation, logs full diagnostics, and translates known `RemoteError` codes into model-recoverable guidance; raw provider or persistence text never reaches the model. The successful `session_create` result is also persisted as the `tool/result` `meta` (via `output.presentationMeta`), which the Web card reads for replay-stable rendering.

</details>

-----

## Further Exploration

Read these pages when the package-level contract is not enough.

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-manage) — the four tool schemas as the model sees them.
- [dsh-api-session-controller](../session-controller/README.md) — the Session commands and catalogs these tools call.
- [dsh-workspace](../../workspace/workspace/README.md) — the project registry and archive state behind `list_projects` and blank reuse.
- [dsh-client-ui-session-manage](../../client/ui-session-manage/README.md) — the Web card for `session_create` results.
- [Session engine and model selection](../../../docs/main-agent-engines.md) — how engines lock and how model catalogs stay engine-relative.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The model receives one fixed composition-guidance section.

##### Composition guidance

```markdown
When the user names a project, engine, or model by voice, resolve each with list_projects, list_engines, and list_models, then pass the resolved ids to session_create instead of the spoken names. Requests to create or open a user-visible session belong to session_create; reserve teammates for requests that explicitly ask for Agent Teams.
```

#### Token effect

One fixed concise section is present on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while the plugin and guidance text are unchanged.

### Tool schemas

#### What the model sees

The model sees the generated [`list_projects`, `list_engines`, `list_models`, and `session_create` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-manage). Catalog parameters stay minimal — `list_models` takes only an optional engine id — while `session_create` declares the id-based location, engine, model, and title fields and states that it creates a user-visible top-level session, not a teammate.

#### Token effect

Four fixed schemas are sent on each request while visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Catalog calls return bounded JSON objects (projects, engines, or provider-grouped models); `session_create` returns the created Session id, resolved engine and model, accepted title, and whether a blank Session was reused. Errors carry one stable `SESSION_MANAGE_*` code with recovery guidance.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; catalog sizes follow the deployment's registered projects, engines, and models.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Web-composition services only** — the plugin requires `sessionController` and `workspaceRegistry`, which ship in the Web application composition; headless or SDK profiles must mount them explicitly.
- **Conversation request is the authorization** — `session_create` asks no confirmation, matching the "new session" button; deployments wanting a confirmation step should add a `tools/pre-execute` approval listener.
- **No navigation** — the tool creates the Session and the Web card offers opening it; the model cannot switch the user's current view itself.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: model-driven navigation

Whether a follow-up tool should let the model switch the Web client's active Session (rather than only offering the open action on the result card) is undecided; it would add a new Host-to-Client request channel.

</details>

**Runtime invariant:** No companion is published. The tools are read-only catalog adapters plus one create that delegates every durable write to the session controller, which already owns session persistence and its invariants.
