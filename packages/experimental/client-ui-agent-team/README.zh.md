---
description: "使用并排查实验性 Web Agent Teams roster、任务看板与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包在 Web 会话页头提供一个 Agent Team 入口。面板融合成员列表、任务看板与引擎原生子项输出；右侧栏团队页在成员列表与折叠任务看板上方叠加只读流程执行图。当 Lead 通过 `team_workflow_create` 提交工作流时，会话将提交的阶段与依赖渲染为一张只读计划卡。它从共享 Session store 读取 Lead Session 的 `agentTeam` 投影，Host 投影 frame 使其保持最新而无需刷新控件，并让子会话导航继续使用稳定的 addressed-subagent 路径。通过公开发布的实验性 Agent Teams bundle 选择本包。这个浏览器 projection 不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

右侧栏提供“团队”页面，可以从侧栏导航页或顶部团队面板的“在右侧查看团队”打开。页面自上而下叠加流程执行图、成员、任务三个可折叠区域，提供区域与分组两级折叠控件、折叠后仍可见的实时计数摘要，以及作用于当前区域分组的全部展开／全部折叠。页面按照失败、状态未知、运行中、待运行、已完成和空闲分组展示成员；同组成员在分组内以紧凑卡片并列排布，随可用宽度自动换行，窄侧栏自然退为单列。点击成员进入其可继续的 Session，团队页面随成员切换保留。只有成员至少有一个已分配任务、所有已分配任务均完成且具备开始和结束记录、并明确停止运行时才归入已完成。标记完成但没有执行时间的任务归入未运行；旧记录缺失的时间不推测补齐。空闲表示没有已分配任务，或有开始记录但不满足完成条件；顶部成员状态与右侧分类保持一致。所有成员分组都采用单列列表。团队右侧面板仅由用户点击打开，子代理活动或切换会话不会自动打开面板。有未完成任务的未运行成员归入待运行。任务通过团队内唯一且不可变的成员名称关联；邮箱队列和授权请求没有独立徽标。对话输入、授权和中止继续由现有 Session 页面处理。

成员条目不显示时间。任务卡片以浏览器本地时间显示首次开始与最后结束时间；任务重新运行期间仍显示此前最后一次结束记录。详情展开和收起按钮位于说明文本上方，不会随展开内容移动到底部。

时间标签采用“开始”和“结束”，本地时间仅显示月、日、小时和分钟。耗时从首次开始计算到最后结束，运行中计算到当前时间并每分钟更新；多次运行之间的间隔也计入耗时。任务卡片不显示写入范围列表，保留范围重叠警告。

-----

<a id="use-this-package"></a>
## 使用本包

通过 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 启用本包。这个组合包同时提供团队服务、工具与 Web 界面。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

面板从共享 Session store 展示 Lead Session 的 roster 与任务板。面板保持打开时，任务和成员更新会直接出现。打开面板不发起投影请求。会话或 Session 列表正在加载时，面板显示加载提示；加载结束后仍无 Team 值时，显示不可用提示。

Roster 行展示持久名称与阶段，名称后以括号显示执行引擎：外部引擎成员显示 `engine:` provider 命名空间中的引擎 id，其余成员显示 native，Lead 始终为 native。provisioning 和 running 成员使用共享 ongoing loading，空闲与未运行成员使用人物图标，已完成成员使用 done 绿点，failed 成员使用 error 红点。实时 Session 状态提供运行活动；共享 `modelSelection` 投影在可用时提供模型。当前会话带有“当前会话”标签且不可选择。在 teammate 会话中选择 Lead 会直接打开 Lead Session。选择 active teammate 会打开其普通 continuable 子会话地址。Host 在打开历史时校验 parent、child 与 mode；后续人类提示词使用同一 addressed-subagent 会话。

### 折叠区域与流程执行图

区域标题在折叠后仍显示名称、总数与简短状态摘要，支持键盘操作并携带 `aria-expanded` 与 `aria-controls`；折叠包含焦点的正文时焦点返回标题，隐藏内容退出 Tab 顺序。成员区域按状态分组独立折叠；任务区域分为执行中、待执行、已完成三组，等待依赖的任务计入待执行，已完成默认折叠；流程执行图默认折叠，可点击标题展开。折叠偏好以 Team 根 Session、区域和分组为键保存在浏览器存储中，不写入 Session 日志：兄弟成员会话共享同一偏好，不同 Team 使用各自默认值，实时更新不覆盖用户选择，新出现的分组按默认规则展示。

流程执行图为每个未删除任务渲染一个只读节点，为每条 `blockedBy` 前置渲染一个箭头，按最长前置链自左而右分层，同层节点按任务创建顺序自上而下堆叠。实线表示前置已完成，虚线表示前置未完成；任务板中缺失的前置显示为只读虚框占位节点，出现依赖循环时显示提示，任务列表始终是权威入口。节点通过图标加文字和可访问名称表达标题、状态、任务 ID 与负责人。画布提供适应画布、放大、缩小和全屏；拖拽平移，滚轮保持侧栏滚动。只有任务集合或依赖变化才重新布局，状态与负责人更新原位改写节点内容，适应画布只发生在首次加载或用户点击，实时更新保留视角。指针或键盘选择节点会展开任务区域及所在分组，滚动到对应任务卡并短暂高亮；选择同时列出该节点的直接前置与后续任务。

### 查看任务板

可开始的 pending 任务使用 idle 灰点，被依赖阻塞的 pending 任务使用 warning 橙点，in-progress 任务使用 ongoing loading，completed 任务使用 done 绿点。

只读任务板展示任务标识、负责人、依赖、就绪状态、提示性写入范围与重叠警告。说明默认截断为一行，展开按钮可查看全文；较长的任务列表在分组正文的有界滚动区域内滚动，不再撑长侧栏。负责人名称在当前名册能唯一解析到一个持续 active 且非当前会话的成员时变为可点控件，点击打开该成员会话查看执行输出；未领取任务与无法解析的名称保持纯文本，任务卡本身仍为只读。「任务看板」标题在头部面板与右侧页面常驻并显示任务数量；空任务板在标题下显示简短描述，只有一名成员且无任务时采用单列面板。Team agent 通过工具创建和更新任务；面板不提供任务修改控件。当投影报告某条持久 Team 记录被拒绝时，面板在最后有效的 roster 与任务上方显示该失败。

### 阅读会话中的工作流计划卡

当 Lead 调用 `team_workflow_create` 时，会话在该次调用处显示一张只读卡片，标题为工作流名称与任务数量：每个阶段按调用顺序成为一个节点，每对有效的 `after` 依赖成为一条中性实线箭头。画布在挂载时自动适应布局，不提供平移、缩放或选择控件。卡片由日志中的调用参数派生，历史回放可以复现；从未创建过任务的计划——阶段名重复，或 `after` 引用未知、自身或靠后阶段——只保留通用工具行。阶段节点按定义渲染为待处理；实时状态仍在右侧栏团队页的流程执行图上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 通过 Cordis effect 注册 locale dictionary、conversation-header action、团队侧栏类型、内容与标题；它不挂载任何 Remote namespace。Dispose plugin fiber 会移除这些 registration。

面板渲染在会话容器外，并保持在视口范围内。成员卡片在静止、选中和悬停状态下均使用共享 elevation 描边绘制轮廓。悬停触发按钮 150ms 后打开面板；指针离开触发按钮和面板后，经过 120ms 宽限关闭。点击触发按钮会固定面板并将焦点移入其中。点击外部或按 Escape 可关闭面板；仅当焦点原本位于面板内时，Escape 才将焦点返回触发按钮。页头较窄时触发按钮折叠为图标，只响应点击打开。组件从 `useSessions`、`useSessionStatus` 与 `useSession` 座位派生每一行：Lead 身份来自当前 Session 的 subagent address，Team 视图来自 `projectionsBySession[lead].values.agentTeam`，成员活动来自 Session 状态并以列表摘要为后备，model 来自 `projectionsBySession[member].values.modelSelection.next`。每个 roster 行只选择自己的运行状态。成员导航回调通过当前与目标 Session 的 id 打开 roster Session。切换会话会关闭面板并清除导航失败。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | locale、导航、conversation node 与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | 由投影派生的 roster、任务看板与引擎子项 |
| [`src/client/TeamDashboard.tsx`](src/client/TeamDashboard.tsx) | `TeamDashboard` 叠加流程图、折叠成员分组与 `TaskGroups`；`TeamDashboardTitle` 提供标签图标与名称 |
| [`src/client/TeamSection.tsx`](src/client/TeamSection.tsx) | 共享可折叠区域：可访问标题、计数与焦点返还 |
| [`src/client/TaskGroups.tsx`](src/client/TaskGroups.tsx) | 折叠任务分组、全板计数与图节点定位 |
| [`src/client/TaskDependencyGraph.tsx`](src/client/TaskDependencyGraph.tsx) | 团队页流程图：适应、缩放、平移与全屏 |
| [`src/client/TaskFlowCanvas.tsx`](src/client/TaskFlowCanvas.tsx) | 团队页流程图与计划卡共享的只读流程 svg 主体 |
| [`src/client/WorkflowPlanCard.tsx`](src/client/WorkflowPlanCard.tsx) | `WorkflowPlanCard`：一次已创建工作流的会话渲染器 |
| [`src/client/workflow-definition.ts`](src/client/workflow-definition.ts) | 将 `team_workflow_create` 调用折叠为计划卡的会话节点定义 |
| [`src/client/workflow-plan.ts`](src/client/workflow-plan.ts) | 从日志调用参数恢复工作流计划的解析器 |
| [`src/client/task-flow.ts`](src/client/task-flow.ts) | 纯函数任务分组、状态映射、分层图布局与适应计算 |
| [`src/client/fold-state.ts`](src/client/fold-state.ts) | 折叠状态 hooks，Team 切换时重读存储选择 |
| [`src/client/collapse-preferences.ts`](src/client/collapse-preferences.ts) | 校验后的浏览器存储信封，保存每 Team 折叠选择 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams bundle](../agent-team-profile/README.zh.md)——挂载本 Client plugin 的公开 opt-in bundle。
- [Agent Teams service](../agent-team/README.zh.md)——权威 roster、task 与投影行为。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布规则。

-----

## 原生子代理状态

同一个顶部入口和右侧标签页通过当前 Session 的 `engineSubagents` 投影展示 Claude/Codex 内部子代理。`Roster.tsx` 为原生与外部子代理提供共享状态分组和成员按钮；`EngineSubagents.tsx` 提供可展开的只读输出、原生身份、可用时的上级身份、模型与进展。引擎子代理按运行中、待运行、已完成、失败、已停止或状态未知分组，现有右侧标签页仅由用户手工点击打开。它们不进入最近或项目列表，不提供 Harness 会话导航或执行控制。输出受长度限制，仅展示原生协议发布的内容；缺少的字段不显示。原生 Team 成员的导航和分类仍由原有适配器负责。

引擎子项和 Team 控件共用一个标题栏下拉框。原生条目可展开查看已接收的输出和状态，不提供可继续的 Harness 子会话入口。团队成员行承担成员子会话的导航；其他 Harness 子会话不进入该面板。同一面板保留手工打开右侧团队页的按钮。Team 投影存在时隐藏独立的子智能体计数入口；普通会话仍保留该入口。

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有 mailbox timeline**——投影视图只承载 roster 与任务；不显示 peer 消息。
- **晚启用插件** — 在已经打开的会话中启用 Agent Teams 后，需要刷新页面才能接收其 Team 投影。
- **模型可用性** — 仅当共享 store 包含该成员的持久选择或请求时才显示模型。冷缓存中缺少的值会保持缺失，直到正常 Session 加载或实时更新提供它们。
- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent 提示词路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。
- **流程图仅作展示**——节点不派发、领取或完成任务；负责人仍按名称关联且不打开会话，投影中没有审批状态。
- **折叠偏好按浏览器保存**——存储在单一版本化 `localStorage` 键下；清除站点数据会重置，头部面板与侧栏共享的每 Team 选择在各自下次挂载后生效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Host 投影是权威来源，本包持有可释放的 UI 注册。
