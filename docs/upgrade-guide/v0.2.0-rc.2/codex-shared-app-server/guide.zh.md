---
kind: upgrade-guide
description: "Codex 主引擎现在让每个普通会话共享同一个 app-server 子进程与共享原生目录；会话只能选择启动时注册的厂商路由。"
---

# Codex 会话共享同一个 app-server 进程

[English](guide.md) | 中文

## 变更

此前每个 Codex 主会话都会启动自己的 app-server 子进程，并使用独立的哈希目录 `$DSH_HOME/engines/codex/session-homes/<sha256(sessionId)>` 作为 `CODEX_HOME`。每个会话都在自己的进程启动前解析厂商路由、模型目录和凭证。

现在引擎在进程启动时启动一个共享的 app-server 子进程，每个普通对话以原生线程挂载到它上面。厂商路由在子进程启动时由 `main-engine-codex` 配置中的 `providers` 映射和 `provider` 字段固定，每个线程通过原生 `modelProvider` 字段选择自己的路由。会话选择了未注册路由时不再启动私有子进程，而是大声失败。配置或凭证变化会在轮次之间重启共享子进程，随后每个会话通过 `thread/resume` 重新挂载自己的线程。

对话共享位于 `$DSH_HOME/engines/codex/shared-home` 的原生目录，其中的 SQLite 与日志目录也共享。旧版本持久化的会话可以照常恢复：其 rollout 会从旧的按会话目录只读拷贝过来。代理作用域携带 Harness Team 工具的会话仍保留专用的按会话子进程与目录，因为其按代理的 MCP 桥接需要私有进程。

## 迁移

1. 在 `cordis.yml` 的 `main-engine-codex` 配置里，把会话可能选择的每个厂商路由都写入 `providers`；不在该映射也不在 `provider` 中的路由会在准备时失败，并列出已注册路由。
2. 升级后重启一次进程；现有 Codex 会话随后从共享目录恢复，无需其他操作。
3. 确认：新会话运行时进程树里只有一个 `app-server` 子进程；升级前的会话能继续对话，而不是报告缺少历史。
