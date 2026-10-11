---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-team-controlled-scheduling

[English](2026-10-07-team-controlled-scheduling.md) | 中文

## 概述

增加持久化任务审批与执行元数据、声明式输入／成果路径，以及一次性原子创建完整任务计划的事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

新字段为可选，因此旧 team/task 记录仍可读取，投影会提供运行时默认值。新增的 team/tasks 事件属于附加事件，旧读取器会拒绝未知事件类型；它不改变现有事件载荷或 Session 头。

<a id="verification"></a>
## 验证

agent-team、tool-agent-team、持久化及 Codex 存储定向测试通过，变更包的 TypeScript 构建通过。

<a id="dev-note"></a>
## 开发备注

无。
