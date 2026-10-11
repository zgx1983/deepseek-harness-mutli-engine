---
kind: upgrade-guide
description: "个人助理任务记录迁入 SQLite 存储域并引入固定工作目录，同时移除客户端替换路径。"
---

# 个人助理任务迁入 SQLite 存储并引入固定工作目录

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，`dsh-personal-assistant` 插件把任务和协调会话引用保存在 `<DSH_HOME>/personal-assistant/tasks.v1.json`，创建协调会话时不指定工作目录，并允许客户端在会话目录查不到该会话时自行替换。POST `/api/personal-assistant/tasks` 路由接受 `dashboardReplaceCoordinatorSession` 操作。

插件现在把同样的数据保存在 `personal_assistant` 存储 domain 中——一张以任务 ID 为键的 `tasks` 表，加一个持有会话引用、`coordinatorDirectory` 身份和 `coordinatorHistory` 条目（`corrupt-history` 与 `working-directory-moved`）的协调会话单例。组合包把这个 domain 路由到 SQLite 数据库 `$DSH_HOME/storages/personal-assistant.db`，其余 domain 仍走基座 `json` 默认路由。插件同时解析助理工作目录——即可选配置 `assistantWorkingDirectory`，默认 `<dataDirectory>/workspace`——并只在该目录内创建、复用、迁移和恢复协调会话；目录不一致时迁移会话并保留旧 Session 日志；另一存活 Host 以不同目录确认同一存储时报配置冲突。`dashboardReplaceCoordinatorSession` 操作已移除；客户端保留分配到的身份并重试加载。

任务记录不做迁移。上一版本的 `tasks.v1.json` 保留在磁盘上，不再读写。

## 迁移

1. 重启运行中的 profile，使 Host 路由、存储行和客户端 bundle 一起加载。组合包 patch 插入 `storage-sqlite` 行并整行重述 `storage-domain` 行加入 `routes: { personal_assistant: sqlite }`；自行覆盖这两行的组合必须包含同样的路由。
2. 若要继续使用之前的会话工作目录，在首次打开页面前，把插件 `cordis.yml` 配置中的 `assistantWorkingDirectory` 设为该绝对目录。未设置时使用默认值 `<DSH_HOME>/personal-assistant/workspace`，首次打开助理页面会把协调会话迁移进去。
3. 升级后重建需要的任务——记录不会延续。确认：GET `/api/personal-assistant/config` 返回解析后的 `assistantWorkingDirectory`，助理页面打开已保存会话，且 `$DSH_HOME/storages/personal-assistant.db` 已生成。确认旧文件没有仍需要的内容后，删除 `<DSH_HOME>/personal-assistant/tasks.v1.json`。
