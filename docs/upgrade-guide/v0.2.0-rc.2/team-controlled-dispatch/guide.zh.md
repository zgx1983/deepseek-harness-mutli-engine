---
kind: upgrade-guide
description: "Team 的 send_message 不再唤醒非活动成员并移除 force；dispatch_task 成为唯一执行启动入口并返回结构化拒绝；spawn_teammate 领取其任务。"
---

# Team 受控调度与无唤醒消息

[English](guide.md) | 中文

## 变更

Agent Teams 的启动路径统一到 Host 的调度入口之后，三项模型可见的工具行为发生变化，并新增一个服务 API。

`send_message` 只承载讨论。运行中的成员在最近的步骤边界读取；非活动成员将消息排队等待其下一次被授权的启动，而不再被启动或冷恢复。`force` 参数被移除——刻意的抢占是先 `interrupt_agent` 再 `dispatch_task`。过去会唤醒空闲 teammate 的消息现在返回 `queued`。

`dispatch_task` 是唯一的执行启动。每次调用在一个串行化事务里于最新修订上重新校验任务，为指定 teammate 领取，并以唤醒授权投递工作指令。被阻塞、已有归属、非 pending 以及未知目标会返回带 `dispatched: false` 的结构化 `refusal`（`reason`、`blockedBy`、`ownerName`、`taskStatus`、`memberPhase`）而不是抛错；重复同一调度请求返回原分配结果而不重复投递工作指令。结果字段 `sent`/`targetStatus` 变为 `delivery`/`interrupted`。

`spawn_teammate` 在成员的 provisioning 事务内领取 `task_id` 指定的任务，创建失败时释放；被阻塞或已有归属的任务会拒绝 spawn（`TEAM_TASK_NOT_DISPATCHABLE`）。初始任务提示现在说明任务已分配，成员不再自行 claim。

服务面上，`ctx.agentTeams.dispatchTask(caller, request)` 为新增，`SendTeamMessageRequest` 增加 `wake`——普通发送默认无唤醒，只有调度入口传递唤醒授权。Claude 与 Codex 成员通过 `dsh_team` MCP 桥接受相同规则。

受影响用户：挂载实验性 Team 包的所有组合、使用 `send_message { force: true }` 或依赖消息唤醒空闲 teammate 的脚本与提示，以及直接调用 Team 服务 API 的代码。

## 迁移

1. 将 `send_message { force: true }` 的抢占改为对目标 `interrupt_agent`，再用 `dispatch_task` 下发工作指令。
2. 将基于消息的工作交接改为 `dispatch_task`；发给非活动成员的普通消息现在返回 `queued`，不再启动进程。
3. 从结构化结果读取调度拒绝（`refusal.reason` 及 `blockedBy` 或 `ownerName`），并把重复调度视为幂等而非错误。
4. 按更新后的服务类型重新编译：新增 `dispatchTask`，`SendTeamMessageRequest` 携带 `wake`。
