---
kind: upgrade-guide
description: "个人助理任务获得执行配置与交付制评审，新增 Todo、知识目录、会话导航与受限执行工具；存储 schema 在 v2 内增量演进。"
---

# 个人助理任务闭环、Todo 与知识

[English](guide.md) | 中文

## 变更

此前任务启动只创建执行会话，不选择引擎与模型；回合成功结束即把任务置为等待验收；执行会话只能以只读记录查看；没有 Todo 与长期知识。

本批之后：

- **执行配置。** 任务携带引擎/厂商/模型配置，按任务 → 父任务 → 插件默认（`defaultEngineId`、成对的 `defaultProvider`＋`defaultModel`）回落；`startTask` 接受可选覆盖。启动链为解析配置 → 按引擎创建 Session → `selectModel` 安装模型 → `prompt` 提交首条任务消息；任一步失败任务进入需要处理并保留原因。配置无效拒绝启动，Host 不替换模型。
- **交付制评审。** 进入等待验收的唯一通道是受限工具 `task_execution` 的 `deliver`；未提交成果的回合结束进入需要处理——依赖旧自动评审的自动化应改为检查 `deliverable-submitted` 活动或成果列表。
- **受限工具，三引擎。** 执行会话获得 `task_execution`（查询任务、报告进展/阻塞、提交成果）；绑定由 Host 的 Session–Execution 关联判定，仅进行中的尝试可读写。Native 走框架注册；Claude/Codex 经 `dsh-subagent-in-process-driver` 的会话级 MCP 桥获得同一工具，桥现在也会为仅执行作用域启动。既有 Team 行为不变。
- **会话导航。** 任务卡、详情与成果引用提供"进入会话"打开确切执行会话，返回恢复助理视图；此前只能只读查看记录。
- **对话验收。** 协调工具新增 `accept` 动作，须经 user-questions 由用户确认后才以用户身份执行；无该服务时保持面板验收路径。
- **Todo。** 新增 `todos` 表与 `listTodos`、`createTodo`、`updateTodo`、`completeTodo`、`reopenTodo`、`cancelTodo`、`restoreTodo`、`convertTodo` 操作；`convertTodo` 同事务完成任务创建与 Todo 状态并按 `requestId` 幂等重放。任务记录新增可选 `sourceTodoIds`、`sourceKnowledgeId` 与执行配置字段。
- **知识。** 新增 `knowledge` 索引表与 `listKnowledge`、`getKnowledge`、`createKnowledge`、`updateKnowledge`、`importKnowledge`、`refreshKnowledge` 操作。`knowledgeDirectory`（默认 `$DSH_HOME/personal-assistant/knowledge`）下的 Markdown 文件是权威正文，数据库只存可重建索引；更新冲突报 `knowledge-conflict`。
- **配置路由。** 插件配置新增 `defaultEngineId`、`defaultProvider`＋`defaultModel`、`knowledgeDirectory`；GET 响应返回这些字段。
- **存储。** domain 保持版本 2：新增字段全部可选、新增表初始为空，旧 2.x 数据照常打开，无迁移步骤。

## 迁移

1. 备份 `$DSH_HOME/storages/personal-assistant.db` 与知识目录。
2. 重新构建并安装插件，重启 profile，使 Host 路由、客户端 bundle 与 MCP 桥一起加载。
3. 确认：配置路由返回 `knowledgeDirectory`；既有任务不变；新执行在详情中展示引擎/厂商/模型快照。
