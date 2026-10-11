---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-team-member-cwd

[English](2026-10-05-team-member-cwd.md) | 中文

## 概述

为 TeamMemberSnapshot 增加可选 cwd，记录创建时 spawn 指定并解析后的绝对工作目录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效。该字段可选且在成员持久生命周期内不可变；投影折叠兼容缺失该字段的旧记录，缺失时沿用 Lead 工作目录语义。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team/tests/projection-events.spec.ts：26 个测试通过，包含 roster 行携带被启动成员 cwd 的用例。

<a id="dev-note"></a>
## 开发备注

无。
