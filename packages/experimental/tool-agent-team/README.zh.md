---
description: "十二个让模型创建、发消息与协调 teammate 的工具，供挂载实验性 Team 插件的组合使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

## 概述

本包让模型创建具名 teammate、向它们发送消息、查看可用状态、等待进展、中断卡住的工作，并通过共享任务板协调，包括一次调用创建工作流与派发就绪任务。每个团队成员都会获得相同的十二个工具，以及在共享工作区协调的指引。当模型只应在你明确要求后运行团队时，选择本包。它会取代同名的旧版 subagent 控件，因此同时需要两者的组合必须禁用旧定义。本包以实验性名称公开发布，但不提供稳定性保证。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型应该通过工具运行一支团队时，在 `@deepseek-ai/dsh-experimental-agent-team` 之上挂载本包。挂载后，每个团队成员——Lead 与每个 teammate——都会获得相同的十二个工具，以及相同的协作策略。`spawn_teammate` 在初始任务前加上 teammate 的角色和名字。

### 何时选择

当模型应该自行创建与协调 teammate、而不是由人来操作 subagent 控件时，选择它。当同名的旧全局 subagent 工具必须继续可用时，请不要选择：团队工具会为团队成员取代它们，因此想同时使用两者的组合必须禁用旧定义。固定策略只在明确要求团队或 teammate 时创建成员，因此普通任务永远不会自行触发委派。

### 最小工作示例

对现有组合的最小增量是 [agent-team README](../agent-team/README.zh.md#smallest-working-setup) 中的两包片段：持久会话存储、团队领域包与本包。插件本身只有两个可选设置：

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `freshProvider` | `spawn` | 启动 fresh teammate 的提供方 |
| `forkProvider` | `fork` | 启动 fork teammate 的提供方 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

试试这样要求 Lead 模型：「创建一个名为 reviewer 的 teammate 检查 diff，再把变更摘要发给 reviewer」。模型会调用创建工具，然后调用消息工具。

### 模型能做什么

十二个工具分为五类能力：

- **创建 teammate**——`spawn_teammate` 接收名字、描述、初始任务，以及可选的 `cwd`（teammate 的工作目录）；指定任务会在预留成员的同一事务内为该成员领取，创建失败即释放领取；只有 Lead 可以调用它。
- **启动工作**——`dispatch_task` 是唯一的执行启动入口（仅限 Lead）：在最新修订上重新校验任务、为一位 teammate 领取、以唤醒授权投递工作指令，并可先中断运行中的目标；拒绝以结构化原因返回——阻塞、已有归属、状态、目标——绝不启动进程，同一重复请求返回原分配结果而不重复投递。
- **发送消息**——`send_message` 只承载讨论：running 成员在最近的步骤边界读取，inactive 成员将消息排队等待其下一次被授权的启动，结果携带投递前采样的 `targetStatus`。
- **查看与等待**——`list_agents` 返回各成员的 `target`、可用状态，以及通过 `currentTaskId` 标出的当前进行中任务；`wait_agent` 等待下一次团队变化；`interrupt_agent` 停止 teammate 的当前轮次（仅限 Lead）。
- **管理任务板**——`team_task_create`、`team_task_list`、`team_task_get`、`team_task_update` 与 `team_task_approve` 用于创建、查看、更新和审批共享任务。输入、成果、写入范围和审批门槛都会随任务持久化。
- **编排流水线**——`team_workflow_create` 一次调用原子保存命名阶段和依赖（仅限 Lead）；Host 调度器会在审批通过后启动显式分配且就绪的任务，并可等待任务完成、删除或超时。

创建和列表结果使用 `target` 标识成员，不包含成员 Session ID。可将该值用于消息和中断调用，或任务工具的 `owner` 参数；任务的 `ownerName` 使用相同值。`inactive` 表示没有轮次在执行，包括已加载和需要恢复的成员；它不表示任务完成或结果。`provisioning` 与 `failed` 描述成员创建状态。任何成员都可以给任何其他成员发消息并使用任务板；只有 Lead 可以创建与中断 teammate。任务更新保留领域的 owner 与 revision 校验，因此过期的编辑会被拒绝，而不是覆盖更新的成果。

任务结果包含可选的 `startedAt` 和 `endedAt`，由任务状态转换推导，单位为 Unix epoch 毫秒。从未进入 `in_progress` 的任务省略这两个字段。创建、读取、列表及更新共用的输出 schema 均接受这两个字段。

### 成功与失败的表现

发送消息在安全存储后即成功：结果为 `accepted`（已立即送达）或 `queued`（等待目标的下一次被授权启动），排队的消息绝不能重发。`dispatch_task` 返回带已领取任务的 `dispatched`、携带阻塞任务 id 或负责人名称的结构化 `refusal`——被阻塞、已有归属、非待执行、未知目标——或原分配的幂等重放；设置 `wait` 时还会说明等待以完成还是超时结束。当没有其他成员 running 或 provisioning 时，`wait_agent` 会立即返回 `noProgress`，提示调用方先用 dispatch_task 启动 teammate；否则它会等待下一次变化，调用方随后重新读取状态。基于过期 revision 的任务编辑会被拒绝，而不是覆盖更新的成果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在三项承诺之上：

- **按作用域，而非全局。** 每个注册都位于成员 Agent（智能体）自己的 `ctx` 上；安装依据 Agent 发布时可用的成员身份。
- **声明式结果，紧凑 JSON。** 每个工具都声明完整结果 schema，并把该值渲染为紧凑 JSON，因此编译器会对照向模型承诺的结果检查 `execute`，任何结果都不会在缩进上消耗 token。
- **领域掌握裁决权。** 工具委托给 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；适配器不添加更弱的路径。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责模型侧与 scoping 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、固定策略文本与十二个 scoped 工具注册 |
| — | 不发布运行时不变式伴生入口；Team 服务拥有持久化与授权关系。 |

### 策略与工具

member scope 上的一个 `team:policy` 段落说明共享的协作规则；固定文本与十二个工具注册都声明在 [`src/index.ts`](src/index.ts)。十二个工具 schema 注册在发布时被识别为 Team member 的 scope 中。与旧全局 continuable-subagent 控件同名的 scoped 注册只会为团队成员覆盖这些全局控件。

### 按作用域注册与拆除

`maybeInstall` 对每个 live Agent 运行，并订阅 `agent/created`；它跳过没有 Team 成员关系的 Agent。Agent 的 dispose（资源释放）会运行已安装的 disposer，插件 HMR（热模块替换）会在重新安装前对每个已安装的 scope 执行 dispose。每个 disposer 按逆序撤销注册，因此失败的安装不会留下残缺 scope。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从领域服务逐步进入精确 schema 与设计背后的决策。

- [agent-team 包](../agent-team/README.zh.md)——这些工具背后的 `ctx.agentTeams` 领域服务。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与服务 API。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)——模型接收的每个工具 schema。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——模型侧、scoping 与隔离决策。

-----

<a id="model-experience"></a>
## 模型体验

### 成员模型与启动工具

#### 模型看到什么

`list_teammate_models` 返回本地厂商和模型的完整 ID、显示名及兼容的已注册引擎。每个厂商列出的引擎已满足其 URL 要求——claude 引擎需要 `anthropic-api` 端点（Claude 兼容 URL），codex 引擎需要 `openai-compatible` 端点（Codex URL）——且每个引擎条目标注其要求的端点。携带配置诊断或模型发现失败的厂商会被剔除，目录只保留可用路由；显式指定这类厂商时会带着发现失败原因直接报错。Lead 在显式模型请求下先调用此工具，再根据用户简称和需求选择完整 ID，交给 `spawn_teammate`；本地仅查询目录和检查引擎兼容性，不代替模型进行名称匹配。目录结果通过工具事件留存在会话中；Claude/Codex 的 Team MCP 也公开此工具。`spawn_teammate` 接受 `engine`、`provider`、`model`、`reasoning_effort` 和 `cwd`。外部引擎仅允许全新上下文并选择对应的持久 provider；原生上下文保留配置的 fresh/fork provider。显式路由子智能体时，厂商与模型必须同时指定；两者都省略时继承 Lead 路由。工具会原样传递选定名称，不会用本地模型目录解析名称。`cwd`（绝对路径，或相对 Lead 工作目录的路径，必须指向已存在目录）会重新锚定 teammate：其会话头、工具与项目指令（AGENTS.md/CLAUDE.md）都按该目录解析，解析结果记录在 roster 行上；省略时所有成员都在 Lead 工作目录运行。Claude/Codex 成员通过进程专属的 `dsh_team` MCP 连接获得作用域内的 Team 工具。初始提示说明 Lead 身份及共享任务工作流；所有调用保留 Harness 工具管线中的成员身份、权限及 revision 校验。

#### Token 影响

目录结果在每次 `list_teammate_models` 工具事件中留存一次目录 JSON，启动参数以紧凑的 `spawn_teammate` 参数 JSON 传递；这两个工具不添加其它面向模型的文本。

#### KV Cache 影响

工具结果与启动请求追加在共享策略、schema 与历史构成的可复用请求前缀之后，发现与启动调用不会使先前缓存内容失效；roster 行与会话头记录启动路由，不改动该前缀。

### Team 策略与工具

#### 模型看到什么

一段共享 system 策略会说明显式 delegation 要求、共享文件系统与按 teammate 指定 cwd 的行为、文件陈旧版本恢复、Bash／formatter／codegen 风险、task／write-scope 协调、Steer 投递、mailbox 不重试规则，以及 Lead 必须在回答前等待。Lead 与 teammate 的全部十二个 Team schema 相同；执行时检查仅限 Lead 的操作权限。`spawn_teammate` 在初始 user 消息前加上 `<system-reminder>\nYou are teammate "<name>".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>`，接着是一个空行和任务。该前缀不含 Team id，禁用运行时上下文时也能生效。fork 继承历史，不额外添加 Lead 身份消息。

#### Token 影响

每次 Team member 请求都有固定策略与 schema 成本。初始身份文本随普通历史经历后续步骤、冷恢复和压缩；插件不扫描或重新插入它。工具调用会增加紧凑 JSON roster、task、wait 或 receipt 结果。Peer 内容由 Team 领域保留在 target 历史中。

#### KV Cache 影响

provider／model、共享 system 策略和工具 schema 相同时，fork 保留父请求前缀并追加带身份前缀的初始任务。工具结果与 peer 消息追加在可复用请求前缀之后。原先在 system prompt 中记录身份的 Session，首次使用此布局请求时可能改变该前缀；提供方实际缓存命中仍为尽力而为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一次性子代理工具可见性**——进程内一次性子代理在发布后才获得 subagent descriptor。Team 安装因此可能将它们误认作 Lead 并暴露 Team 策略和工具。descriptor 将它们识别为非成员后，调用会被拒绝。安装时序修复留待以后处理。

这些限制说明策略与工具无法为一支团队保证什么。它们是当前包约束，不是与其他协作方式的对比。

- **提示词策略只负责协调，不负责 confinement**——它无法阻止 Bash 或外部进程写入重叠文件。
- **不会自主创建 Team**——除非用户明确要求，普通任务不会触发 delegation。
- **没有 Web 控制功能**——浏览器 roster 与任务板呈现不属于该运行时包。
- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间 schema 仍可自由变更。

<a id="dev-note"></a>

Lead 在派发前通过 `team_task_create` 或 `team_workflow_create` 创建全部计划任务，包括等待依赖的任务；普通 TODO 不会进入 Team 任务板。`team_workflow_create` 在创建任何任务前校验阶段名与前向引用，无效工作流不会改动任务板。`dispatch_task` 把检查过的就绪任务分配给一个 teammate，可选中断目标当前轮次，投递工作指令，并等待任务完成或删除。`spawn_teammate` 接受 `task_id`，复用未领取且已就绪的待执行任务，并在创建成员前拒绝依赖未完成或已领取的任务；省略时仍自动创建初始共享任务。初始提示携带任务 ID，供成员领取和完成。成员创建失败时任务保持待执行状态。用户要求的 review 由 Lead 协调：依赖完成后仍须等待明确确认再派发。

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
