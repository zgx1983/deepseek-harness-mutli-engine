---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-session-total-tokens

English | [中文](2026-10-05-session-total-tokens.zh.md)

## Summary

Adds the optional sessionTotalTokens field to the persisted usage payload carried by assistant streams, assistant messages, and compaction summaries.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-session-total-tokens
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-10-03-native-context-input"
    after: "8ac87fea9419cf3570221564009b5a7e5b577dddbde4b0abf59265971dd039d4"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-10-03-native-context-input"
    after: "7f2562ac18553a615b2b2e1877fd44e4e75f3f856baf17af992dff9a054e97ab"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-10-03-native-context-input"
    after: "ff0afc002f9955313fc9079e75130cbdd80180cc0b26260f0e3432108fe35131"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. The field is optional: readers treat absence exactly as before, and per-call adapters keep omitting it. Engines that surface a running whole-session total may set it; it does not change billed-total arithmetic.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/token-meter/tests/token-usage-projection.spec.ts packages/subagent/subagent-codex/tests/main-usage-wire.spec.ts packages/subagent/subagent-claude-code/tests/engine.spec.ts: 51 tests passed across 3 files.

<a id="dev-note"></a>
## Dev Note

None.
