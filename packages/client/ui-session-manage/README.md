---
description: "Web card for the session_create tool result, with an open-session action."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-manage

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-session-manage` renders the `session_create` tool call in the Web conversation: a compact row showing the target project while the call runs, and on success the created Session's engine, model, and title plus an open action that navigates to that Session. Everything derives from the durable call slice — the Host tool's persisted result `meta` — so replays render the same card without any live lookup.

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

The package ships with the Web application; no user configuration exists. When a `session_create` call settles, its row shows the resolved engine, model, and title from the persisted meta and offers `Open session` for Sessions the Host session list still carries.

### When to choose it

Choose it in any composition that mounts the `dsh-tool-session-manage` Host plugin and wants the created Session reachable from the result card. Without it, `session_create` results still render through the generic Tool card but carry no open action.

### Failure behavior

Malformed or missing result meta degrades to the generic summary text with no open action; a Session absent from the Host list (for example archived) also drops the action, so the card never offers a dead navigation target.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers the `session_create` wire name in ui-tool's keyed `tool.call.toolview` slot at priority `-10`, ahead of ui-tool's generic details row, with the `session-manage` locale namespace and an injected `openSession` action. `SessionCreateRow` narrows the `ToolResultNode.meta` persisted by the Host tool's `presentationMeta` into `{ sessionId, engineId?, model?, title?, reused }`; the open action calls `ctx.uiWorkspace.openSession` only when the id is still present in the Session list snapshot. Pending rows show the target project parsed from the call arguments, with the call id as fallback.

</details>

-----

## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-tool-session-manage](../../api/tool-session-manage/README.md) — the Host tool whose result meta this card renders.
- [dsh-client-ui-tool](../ui-tool/README.md) — the keyed toolview slot and generic fallback card.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser UI registers no model-facing tools or messages; the Host `dsh-tool-session-manage` plugin owns every model-visible surface.

#### KV Cache effect

None. Card presentation does not enter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The card presents only what the persisted result meta carries; a replay from an older tool version without that meta renders the generic summary and no open action.
- The open action navigates without confirming; the Session's own archival state is the only guard (an archived or dropped Session hides the action).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: richer created-session summary

Whether the card should show the workspace title or the reused-blank marker alongside the engine and model is undecided; both are available in the persisted meta.

</details>

**Runtime invariant:** No companion is published. The card renders logged call slices only and registers no durable state, service presence, or event relationship of its own.
