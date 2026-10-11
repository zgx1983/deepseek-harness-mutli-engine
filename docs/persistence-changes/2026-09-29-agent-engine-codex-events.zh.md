---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-agent-engine-codex-events

[English](2026-09-29-agent-engine-codex-events.md) | 中文

## 概述

新增仅日志的 engine/input-submitted、engine/item-settled 与 engine/turn-settled 事件，记录可观察的 Codex 主聊天执行。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有记录保持有效。三个均为新的可选仅日志事件，仅由 Codex 主引擎发出；没有这些事件的会话不变地运行原生循环。它们不进入派生模型历史，也不改变任何现有事件或头结构。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/subagent-codex/tests/engine.spec.ts：通过。pnpm run verify-persistence-changes：已确认。

<a id="dev-note"></a>
## 开发备注

无。
