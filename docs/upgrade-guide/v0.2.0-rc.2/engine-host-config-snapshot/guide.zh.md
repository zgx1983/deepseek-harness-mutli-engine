---
kind: upgrade-guide
description: "Harness 不再读取宿主 Claude 或 Codex 权限配置；会话权限预设成为唯一权限来源。"
---

# 不再读取宿主引擎权限配置

[English](guide.md) | 中文

## 变更

Claude 引擎此前把 `~/.claude/settings.json` 的 `permissions` 段镜像进自己的配置目录；Codex 引擎此前把 `~/.codex/config.toml` 的权限字段和每个 `~/.codex/rules/*.rules` 文件镜像进每个会话目录，且宿主配置逐字段覆盖会话权限预设。

现在两个引擎都不再读取这些宿主文件。会话权限预设成为唯一权限来源：Claude 把完全权限映射为 `bypassPermissions`、工作区修改映射为 `acceptEdits`；Codex 把每个预设直接映射为线程的 sandbox、审批策略与审批人。宿主权限规则既不能限制也不能重新定义会话。非权限的记忆仍然镜像（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、skills）。

Claude 主引擎（`main-engine-claude`）的部署键 `permissionMode`、`settingSources` 与 Codex 主引擎（`main-engine-codex`）的 `mirrorUserConfig` 已删除。

## 迁移

1. 原本依赖 `~/.claude/settings.json` 或 `~/.codex/config.toml` 中权限规则的，请迁移到 Harness 会话权限预设（`/permission`）；宿主文件不再影响会话。
2. 从 `cordis.yml` 的 `main-engine-claude` 配置中移除 `permissionMode` 和 `settingSources`，从 `main-engine-codex` 配置中移除 `mirrorUserConfig`；加载器会拒绝未知键。
3. 确认：工作区修改会话自动接受文件编辑，仅可查看会话在执行任何操作前询问，完全权限会话无论宿主配置如何都不再询问审批。
