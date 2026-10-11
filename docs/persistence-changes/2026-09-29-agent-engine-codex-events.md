---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-agent-engine-codex-events

English | [中文](2026-09-29-agent-engine-codex-events.zh.md)

## Summary

Adds the log-only engine/input-submitted, engine/item-settled, and engine/turn-settled events recording observable Codex main-chat execution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-agent-engine-codex-events
baseline: false
changes:
  - root: "event:engine/input-submitted"
    previous: null
    after: "db37da3df44dafc5e9db98230270761dde86504819a0c495d14ff550fc0a8d4b"
    decision: same-version
  - root: "event:engine/item-settled"
    previous: null
    after: "b013b5d2693e168c5a4728e2940a856faddc0ff7f07bea5da6d9c0d5f6a45c6c"
    decision: same-version
  - root: "event:engine/turn-settled"
    previous: null
    after: "7ce6ecf4a0154e5e5df263dda979f54979cbf0490aaf1a3b4ee7c47fc9402f8e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. All three are new optional log-only events emitted only by the Codex main engine; a Session without them runs the native loop unchanged. They never enter derived model history and change no existing event or header shape.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/subagent-codex/tests/engine.spec.ts: passes. pnpm run verify-persistence-changes: acknowledged.

<a id="dev-note"></a>
## Dev Note

None.
