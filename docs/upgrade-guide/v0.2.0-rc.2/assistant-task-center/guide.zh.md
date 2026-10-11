---
kind: upgrade-guide
description: "个人助理升级为父子任务、依赖与验收模型，任务数据迁入版本命名的 v2 存储 domain。"
---

# 个人助理父子任务工作台与 v2 存储

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，`dsh-personal-assistant` 把每个任务保存为 `personal_assistant` 存储 domain（v1）单层 `tasks` 表里的一条记录，任务内的 `runs` 数组记录执行；POST `/api/personal-assistant/tasks` 只接受 `dashboardSnapshot`、协调会话操作、`create`、`start`、`update` 和 `dashboardStopWorkItem`。

插件现在把任务保存在版本命名的后继 domain `personal_assistant_v2` 中：`tasks`、`executions`、`results`、`activities` 四张表加协调会话单例。任务模型固定两级——父任务容器聚合子任务状态，叶任务可多次执行并各自留下 Execution 记录；子任务支持同父任务内的 `dependsOn` 依赖，前置子任务验收后才解锁后继；父任务需要用户整体验收。`update` 操作移除；状态变更改用 `startTask`、`stopTask`、`acceptTask`、`reopenTask`、`cancelTask`，模型拆解与批量编辑使用 `createPlan` 与 `updatePlan`，查询使用 `overview`、`listTasks`、`getTask`、`listChildren`、`listExecutions`、`listActivity`、`listResults`。所有列表采用服务端分页与查询快照（`queryId`、`changedSinceQuery`、`query-expired`）。错误响应带稳定错误码；写操作检查 `expectedRevision` 与 `requestId`。右侧任务面板升级为概览／全部任务／历史三个视图与任务详情。跨记录写入经由存储 domain 新增的原子批次事务（`KvUnit.applyBatch`、`Domain.transact`）提交。

## 迁移

1. 停止使用该助理存储的 Host 进程，备份 `$DSH_HOME/storages/personal-assistant.db`。
2. 重启运行中的 profile，使 Host 路由、存储路由和客户端 bundle 一起加载。组合包 patch 现在的路由为 `routes: { personal_assistant: sqlite, personal_assistant_v2: sqlite }`；自行覆盖 `storage-domain` 行的组合必须包含同样的两条路由。
3. 首次启动自动执行一次性迁移：每个 v1 任务成为无子任务的顶层叶任务，`runs` 映射为 Execution 记录，协调会话 singleton 保留；没有真实验收／完成时间的任务不填充假时间。v1 记录原样保留在旧 unit 中，不会被移动、覆写或删除；旧构建不能读取新数据。确认：助理页面显示原任务与执行历史，`GET /api/personal-assistant/config` 返回查询配置字段。
4. 客户端展示偏好（视图、筛选、页码）按助理工作目录哈希保存；升级后首次打开为默认视图。
