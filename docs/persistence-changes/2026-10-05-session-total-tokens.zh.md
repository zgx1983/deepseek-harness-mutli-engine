---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-session-total-tokens

[English](2026-10-05-session-total-tokens.md) | 中文

## 概述

为助手流、助手消息与压缩摘要所携带的持久化 usage 负载新增可选的 sessionTotalTokens 字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效。该字段可选：读取方对缺失的处理与之前完全一致，按调用计的适配器继续省略它。暴露运行中全会话总量的引擎可以写入它；它不改变计费总额的算术。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/token-meter/tests/token-usage-projection.spec.ts packages/subagent/subagent-codex/tests/main-usage-wire.spec.ts packages/subagent/subagent-claude-code/tests/engine.spec.ts：3 个文件 51 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
