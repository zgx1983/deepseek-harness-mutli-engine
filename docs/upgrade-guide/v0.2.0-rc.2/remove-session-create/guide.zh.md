---
kind: upgrade-guide
description: "移除 session_create 工具及其 profile 配置。"
---

# 移除 session_create

[English](guide.md) | 中文

## 变更

已删除 `@deepseek-ai/dsh-tool-session-create` 包和 `session_create` 工具。已有会话仍可使用；通过应用界面创建新会话。

## 迁移

1. 从 profile 补丁和自定义 Cordis 配置中移除 `tool-session-create` 行。
2. 从自定义解析器清单中移除对 `@deepseek-ai/dsh-tool-session-create` 的直接依赖。
3. 重启应用，确认启动时没有插件缺失错误。
