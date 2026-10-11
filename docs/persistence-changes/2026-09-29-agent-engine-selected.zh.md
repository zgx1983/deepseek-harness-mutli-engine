---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-agent-engine-selected

[English](2026-09-29-agent-engine-selected.md) | 中文

## 概述

新增仅日志的 engine/selected 会话事件，记录会话创建时解析且不可变的执行引擎。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有记录保持有效。engine/selected 是新的可选仅日志事件；没有该事件的会话运行部署默认（原生循环）。事件不进入派生模型历史，也不改变任何现有事件或头结构。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/api/session-controller/tests/engine-selection.host.spec.ts：通过。pnpm run verify-persistence-changes：已确认。

<a id="dev-note"></a>
## 开发备注

无。
