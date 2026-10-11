---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-team-controlled-scheduling

English | [中文](2026-10-07-team-controlled-scheduling.zh.md)

## Summary

Adds persisted task approval and execution metadata, declared input/output paths, and one atomic event for creating a complete task plan.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-team-controlled-scheduling
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "a7223d8a661535567dec8ff9ee410433b254bfddee213f95795b1e959d90f2a2"
    decision: same-version
  - root: "event:team/tasks"
    previous: null
    after: "ee8d8310d2a335ef4103ec6998738812e727a22477f1d6e6d9bac838a073d57d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing team/task records remain readable because the new fields are optional and projection supplies runtime defaults. The new team/tasks event is additive and older readers reject its unknown event type; it does not alter existing event payloads or Session headers.

<a id="verification"></a>
## Verification

Agent-team, tool-agent-team, persistence, and Codex storage targeted tests plus the changed package TypeScript build pass.

<a id="dev-note"></a>
## Dev Note

None.
