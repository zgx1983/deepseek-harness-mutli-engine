# Agent Team 工作流与即时调度优化

[English](agent-team-workflow-dispatch.md) | 中文

## 问题

当前 `tool-agent-team` 只暴露低层原语：`spawn_teammate`、`send_message`、`team_task_create`、`team_task_update`、`wait_agent`。实际使用时暴露出两个结构性问题：

1. **依赖关系没有写进共享任务图**。 Lead 只能靠记忆和手动 `send_message` 维持“设计 → 开发 → 构建 → 测试”顺序；`team_task_create` 的 `blocked_by` 经常被遗漏。结果 `team_task_list` 中 design/dev、build/test 之间没有可见依赖，下游可能在依赖完成前就被错误派发。

2. **没有“立即驱动”子智能体的原子操作**。`send_message` 只是把消息丢进 mailbox：目标 running 时会 queued，不会立即处理；目标 inactive 时才会启动 turn。Lead 无法像“在对话框里 @ 一个人”那样让某个 teammate 马上开始工作，尤其当对方已经卡在一个长 turn 里时。

3. **可观测性不足**。`list_agents` 只返回 `running/inactive/provisioning/failed`，看不到当前 claim 的任务、mailbox 排队深度、当前 turn 已运行多久，导致 Lead 难以判断一个 teammate 是真在工作还是挂死。

## 提案

在 `tool-agent-team` 层增加三个高层能力，且不改动 `agent-team` 服务的持久语义：

### 1. `team_workflow_create` — 一次性建立带依赖的流水线

输入：

```ts
{
  name: string
  stages: Array<{
    name: string
    subject?: string
    description: string
    after?: string[]      // names of dependency stages
    write_scopes?: string[]
  }>
}
```

行为：
- 校验阶段名唯一。
- 按顺序创建 task，把 `after` 解析为已创建 task 的 id 并写入 `blocked_by`。
- 返回 `{ workflow, stages: [{ name, task }] }`。

这样一次调用就能建立设计/开发/构建/测试的完整依赖链，避免 Lead 手动维护 `blocked_by`。

### 2. `dispatch_task` — 依赖检查 + 认领 + 强制唤醒 + 可选等待

输入：

```ts
{
  target: string          // teammate name
  task_id: string
  message?: string        // work order; defaults to the task subject + description
  force?: boolean         // if the target is running, interrupt first
  wait?: boolean          // block until the task completes
  timeout_ms?: number     // defaults to 300000
}
```

行为：
1. `team_task_get` 检查 task 是否 pending 且 ready；若被阻塞则直接报错。
2. CAS claim 给 target。
3. 若 `force` 为 true 且目标 running，先 `interrupt_agent`。
4. `send_message` 投递工作指令。
5. 若 `wait` 为 true，循环 `wait_agent` 并在每次唤醒后重新 `team_task_get`，直到 task 进入 completed/deleted 或超时。

这把“看依赖 → 认领 → 强制唤醒 → 等待结果”合成一个原子操作，直接解决“tester 收到消息但不工作”的问题。

### 3. `send_message` 与 `list_agents` 增强

- `send_message` 增加 `force` 参数，并在返回值中加入 `targetStatus`，让 Lead 知道投递前目标是什么状态。
- `list_agents` 增加 `currentTaskId` 字段，显示每个 member 当前 claim 的 in-progress task，方便 Lead 一眼看出谁在做什么。

## 替代方案

### 为什么不直接改 `agent-team` 服务事件驱动？

服务层目前对“task 就绪后自动唤醒 owner”没有原生支持，因为 blocked task 不能被 claim/assign。如果要在服务层实现自动唤醒，需要：
- 允许 Lead 给 blocked task 预分配 owner（新增 `assign` action 或放宽 `reassign` 的 `taskReady` 检查），或者
- 在 task 就绪时由服务主动发系统消息。

这些改动会跨越 `agent-team` 与 `tool-agent-team` 两个包，影响持久事件格式。本次提案先停留在工具层，用 `dispatch_task` 和 `team_workflow_create` 解决 80% 的编排问题；服务层事件驱动可作为后续升级。

### 为什么不新增 `team_task_subscribe`？

订阅/推模式对模型调用更友好，但需要在 `agent-team` 中增加事件订阅与 owner-wake 机制。工具层的 `dispatch_task(wait: true)` 已经能让 Lead 阻塞等待，语义更简单，且不改变服务契约。

## 验收标准

- `team_workflow_create` 一次调用可创建多阶段 task 并正确设置 `blocked_by`；阶段名唯一性错误、未知依赖错误都有清晰报错。
- `dispatch_task` 在 task 未 ready 时拒绝；成功后将 task 置为 `in_progress` 并归属 target，同时投递消息。
- `dispatch_task({ force: true })` 对 running 的 teammate 先 `interrupt` 再发消息。
- `send_message({ force: true })` 同样先中断再投递，并返回 `targetStatus`。
- `list_agents` 返回的每个 member 带有 `currentTaskId`（仅当该 member 拥有 in-progress task 时）。
- 现有测试全部通过；新增工具测试覆盖 workflow、dispatch、force-send、currentTaskId。

## 风险

- `force` 会强制中断当前 turn，可能丢失未保存的中间结果；文档和工具描述中需要明确这是“强制插队”。
- `dispatch_task(wait: true)` 长时间阻塞会占用 Lead turn；需要设置合理默认超时，并允许用户中断。
- 增强 `send_message`/`list_agents` 输出会改变模型可见 schema，需要同步更新 tool-catalog 与相关测试。

## 开放问题

- 是否需要在服务层支持 blocked task 预分配 owner，从而实现真正的“task 就绪自动唤醒”？
- `list_agents` 是否还应暴露 `pendingMessageCount`、`turnStartedAt` 等更细粒度状态？这需要 `agent-team` 服务暴露 mailbox 与 turn 元数据。
- `team_workflow_create` 是否要支持“为每个阶段自动 spawn teammate”？当前提案只创建 task，spawn 仍由 Lead 显式执行，以保持灵活性。
