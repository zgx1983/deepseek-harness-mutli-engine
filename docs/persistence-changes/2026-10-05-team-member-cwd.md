---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-team-member-cwd

English | [中文](2026-10-05-team-member-cwd.zh.md)

## Summary

Adds optional TeamMemberSnapshot.cwd recording the resolved absolute working directory a spawn named at creation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-team-member-cwd
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "6c5895ca1fb0d85b5d762a98b609f67b26409c40493ec0c579fc399a8537531f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. The field is optional and immutable for the member's durable life; projection folds keep prior records without it, and absence keeps the Lead working directory interpretation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team/tests/projection-events.spec.ts: 26 tests passed, including the roster row carrying the spawned member's cwd.

<a id="dev-note"></a>
## Dev Note

None.
