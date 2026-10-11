---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-agent-engine-selected

English | [中文](2026-09-29-agent-engine-selected.zh.md)

## Summary

Adds the log-only engine/selected Session event recording the immutable execution engine a Session resolved at creation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-agent-engine-selected
baseline: false
changes:
  - root: "event:engine/selected"
    previous: null
    after: "f4d3709de56bfcd63c54bf6e886f82356c6113fec4d2768613e2da29030dfce2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. engine/selected is a new optional log-only event; a Session without one runs the deployment default (the native loop). The event never enters derived model history and changes no existing event or header shape.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/api/session-controller/tests/engine-selection.host.spec.ts: passes. pnpm run verify-persistence-changes: acknowledged.

<a id="dev-note"></a>
## Dev Note

None.
