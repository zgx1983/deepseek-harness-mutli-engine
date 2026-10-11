---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-native-context-input

English | [中文](2026-10-03-native-context-input.zh.md)

## Summary

Adds optional TokenUsage.contextInputTokens for the latest main-model prompt size in an external turn containing multiple internal calls.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-native-context-input
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "b4b74a54434e5dafea464fa7b36a0d86be8eafcb9b170a148d97cccba16a9ca8"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "d84c4623a3003b51aa799cd7dad2faf5000a5d8f2ef39101c690de3dbd0b6eae"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "1d8a5d405c72d1e64dd36124fd4f51a5ce6f0dd30c08f239fcb4de0e1edb5df7"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing usage records remain valid. The new optional field overrides context occupancy pressure only; aggregate billing counters retain their existing disjoint semantics. Older records without this field continue to use input and cache counters. No Session writer version increase is required.

<a id="verification"></a>
## Verification

Focused token-meter and Claude adapter tests distinguish the latest request prompt size from aggregate billed input and preserve existing records without the optional field.

<a id="dev-note"></a>
## Dev Note

None.
