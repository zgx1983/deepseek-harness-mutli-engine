---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-native-context-input

[English](2026-10-03-native-context-input.md) | 中文

## 概述

新增可选的 TokenUsage.contextInputTokens，记录包含多次内部调用的外部轮次中最新主模型提示词大小。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有用量记录仍然有效。新可选字段仅覆盖上下文占用压力；累计计费计数保留原有互不重叠的语义。缺少该字段的旧记录继续使用输入及缓存计数。不需要提高会话写入版本。

<a id="verification"></a>
## 验证

针对性的 token-meter 及 Claude 适配器测试区分最新请求提示词大小与累计计费输入，并保留不含可选字段的已有记录行为。

<a id="dev-note"></a>
## 开发备注

无。
