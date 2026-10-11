---
kind: upgrade-guide
description: "个人助理插件改为项目和 token 看板，并移除任务、待办、知识和助理对话功能。"
---

# 个人助理改为项目看板

[English](guide.md) | 中文

## 变更

`dsh-personal-assistant` 插件现在展示项目与会话活动，以及提供方报告的 token 用量。原有任务和 Todo 管理、个人知识工具、助理对话、配置设置，以及 `/api/personal-assistant/config` 和 `/api/personal-assistant/tasks` 路由均已移除。插件不再挂载 `personal_assistant` 存储路由。

## 迁移

1. 如果仍需旧任务、Todo 或知识记录，请在升级前备份 `$DSH_HOME/storages/personal-assistant.db`。新插件会保留该文件，但不再提供读取界面、API 或迁移程序。
2. 移除调用 `/api/personal-assistant/config` 或 `/api/personal-assistant/tasks` 的客户端，以及依赖此插件模型工具或设置的工作流。
3. 启用更新后的 `dsh-personal-assistant` 浏览器插件。确认侧边栏打开项目看板，并且“刷新”会更新本地当天和七天汇总。
### 会话归档

归档会话会显示确认框，总结选项默认不勾选。勾选后通过 Native、Codex 或 Claude 引擎续用原会话，收到含项目根目录 `CHANGELOG.md` 绝对路径的简短总结请求，并使用自身文件或 shell 工具追加带时间的条目。Host 检查条目后归档，不再写入文件。生成失败时会话保持可见，引擎的文件改动仍保留；现有工具权限仍生效。已有项目文件无需迁移。

将 Host `workspaceController` 上原独立调用的 `changelogSummaryMaxInputBytes` 和 `changelogSummaryMaxTokens` 替换为 `changelogSummaryMaxCharacters`（追加正文默认最多 `800` 个 Unicode 字符）和 `changelogSummaryTimeoutMs`（默认 `120000` 毫秒）。原引擎管理现有上下文，不另外发送一份会话文本。超时会请求取消并等待 Agent 收敛。勾选总结后，确认同一会话中新增总结回复，changelog 中新增带时间的条目；不勾选时仅归档。
