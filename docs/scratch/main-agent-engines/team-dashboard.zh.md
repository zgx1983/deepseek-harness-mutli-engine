# Agent Team Dashboard 详细设计

[English](team-dashboard.md) | 中文

设计参考，部分目标已实现；本稿不作为当前功能状态清单。当前行为见[所属包文档](../../../packages/experimental/client-ui-agent-team/README.zh.md)，已迁移与待完成项目见[功能迁移与迭代清单](../../../worktree-feature-list.md)。历史方案评审日期：2026-10-01；本次状态核对日期：2026-10-04。

## 概述

沿用现有会话布局和输入体验。在现有右侧栏添加团队标签页：按状态分组显示成员，点击后在中间栏打开成员的持久 Session。用户与任一成员交互时，团队仍以 Lead Session 为根。

## 目录

- [当前实现](#current)

- [布局与导航](#layout)

- [状态分类](#status)

- [数据与订阅](#data)

- [异常与交互](#interaction)

- [实现归属](#implementation)

- [交付与验收](#acceptance)

<a id="current"></a>

## 当前实现

现有 [TeamAction](../../../packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx) 是会话头部弹出面板，包含成员列表和只读任务板。[mount.ts](../../../packages/experimental/client-ui-agent-team/src/client/mount.ts) 的 `registerAgentTeamUi` 从 subagent 地址获取 Lead，并以 `mode: continuable` 打开成员 Session。复用这条导航路径，避免新增对话渲染器。

[Team 类型](../../../packages/experimental/agent-team/src/types.ts) 区分持久成员阶段（`provisioning`、`active`、`failed`）和任务状态（`pending`、`in_progress`、`completed`、`deleted`）。客户端投影没有任务 `ownerId`、队列数量、成员轮次错误或等待授权状态。这些需要明确补齐数据；轮次停止不代表任务完成。

多引擎持久成员是独立的[设计依赖](persistent-agent-teams.zh.md)。Dashboard 可以先支持已有原生成员，不能暗示 Claude/Codex teammate 已接通。

<a id="layout"></a>

## 布局与导航

使用现有左侧工作区及会话列表、中间对话和可调整宽度的右侧栏。通过 `sidebarRightTabs`、`sidebar.right.pane.tab` 和 `sidebar.right.pane.tab.title` 注册团队标签页，使用现有成员图标。不要创建平行右栏或替换 `AppFrame`。

```text
+-------------------+----------------------------------+-------------------------+
| Workspaces        | Lead > selected member           | Team / Tasks            |
| Sessions          | Existing conversation transcript | Running (2)             |
|                   |                                  | Pending (1)             |
|                   | Existing composer                | Completed (3)           |
|                   | Model / permissions / cancel     | Idle / Failed / Unknown |
+-------------------+----------------------------------+-------------------------+
```

头部显示团队名称（或 Lead 标题）、固定的 Lead 入口、当前成员名称以及成员和任务数量。Lead 单独放在分组列表上方，不计入 teammate 数量。成员行显示名称、运行状态、已知的引擎和模型、任务进度、可用的排队消息数及未读标记。不能用旧 `provider: spawn/fork` 字段推断引擎。

点击有效成员行调用共享 `openTeammate` 动作，中间栏切换到该 Session，使用其普通输入、授权、停止及模型控制。右栏保持当前团队。点击 Lead 返回父 Session。浏览器历史沿用工作区导航，滚动位置和未发送草稿沿用 Session 存储。打开成员行不会自动发送提示或唤醒进程。

切换到团队以外的会话时释放原订阅，并解析新 Session 所属团队。在相关成员间保留用户选择的团队标签页，不因流更新反复强制展开右栏。用户首次点击团队头部入口时可打开标签页。窄窗口使用现有右栏覆盖层及关闭行为，选择成员后收起覆盖层以展示对话。

<a id="status"></a>

## 状态分类

由生命周期、实时执行、工作和连接事实分别计算成员的唯一展示分组。任务归属必须使用 Session 标识，`ownerName` 仅用于展示。按照以下优先级分类，不以进程是否存活作为完成依据。

| 优先级／分组 | 规则 | 行内说明 |
|---|---|---|
| 1／失败 | 创建失败或明确的最新执行／恢复错误 | 原因与恢复动作，同时保留任务进度 |
| 2／状态未知 | 必要实时状态未加载或连接已失效 | 最后已知状态，绝不能默认已完成 |
| 3／运行中 | 轮次活跃，包括等待授权或用户回答 | 执行中／等待授权／等待回答 |
| 4／待运行 | 创建中、存在排队输入或归属任务尚未完成 | 准备中／排队／依赖阻塞／可执行 |
| 5／已完成 | 至少一个归属任务、全部完成，且没有活跃轮次或排队输入 | 任务已完成，Session 仍可继续 |
| 6／空闲 | 有效非活跃成员，没有待处理工作或明确完成依据 | 空闲，包括已中止及未分配任务的成员 |

已删除任务不参与计算。成员同时有已完成和待处理任务时，空闲阶段归入待运行。任务已完成但仍在执行的成员归入运行中。新输入持久接收后立即移出已完成。最终 assistant 消息、工具结果、进程退出或沉默都不能作为完成证据。没有任务板记录的委派保持空闲，直到团队调度器提供明确的持久委派完成记录；UI 不自行制造此记录。

组内保持稳定成员顺序，分组标题可折叠并显示数量，明确标记当前成员。仅对快速实时更新允许短暂延迟重分组，并通过明确 UI Config 配置；行移动后仍能识别选中成员。搜索按名称、模型及引擎过滤，不改变全团队计数。

<a id="data"></a>

## 数据与订阅

团队标签页挂载时保留一份 Lead 投影。初期从现有 subagent 地址解析 `teamRootId`；持久成员方案需要为重新唤醒的成员提供明确的团队根关联。成员及任务读取 `agentTeam`，引擎和模型读取成员选择投影，执行活动读取共享 Session 状态。订阅轻量成员状态，不为绘制列表打开全部对话或恢复全部引擎。

同步给客户端任务视图及所有生产者和消费者增加 `ownerId`。调度器能提供权威数据后，再增加团队范围的排队输入摘要和新鲜度标识。授权提示应复用能标识成员 Session 的现有交互投影，否则增加专门摘要。这些增强项在数据可用前明确显示未知，不能在浏览器读取私有 inbox 内部实现。

Dashboard 是投影消费者。分组标签、折叠和搜索偏好属于客户端状态，不进入模型输入。成员关系、任务分配和消息投递仍是后端拥有的持久记录。新增持久类型遵循仓库持久化审查；修改展示视图不代表可以改变历史日志。

<a id="interaction"></a>

## 异常与交互

| 状态 | 展示与动作 |
|---|---|
| 尚无成员 | 展示 Lead，简短提示在对话中要求创建成员，不自动创建 |
| 首次加载 | 单一列表骨架，不猜测零数量 |
| 投影错误／断连 | 保留最后有效列表，显示紧凑提示及重试，标记状态失效 |
| 创建中 | 绑定可用前禁用 Session 导航，明确显示待运行原因 |
| 失败但仍有 Session | 允许查看诊断和历史，仅在后端支持时提供显式重试 |
| Session 缺失或不可访问 | 保留成员行，通过应用级 Toast 报告导航失败 |
| 授权／提问 | 行内标记可打开成员 Session，现有对话 UI 负责回答 |
| 中止 | 使用当前 Session 停止动作，不隐式广播中止整个团队 |
| 恢复失败／投递不确定 | 显示成员错误并使用已有恢复流程，不自动重放输入 |

使用主题 token 和现有 StateDot、Tag、Tooltip、骨架及 Toast 组件，颜色必须配文字。功能字体字重不超过 500。键盘可访问分组开关、每个可导航成员和 Lead 入口，当前 Session 使用 `aria-current`。播报重要状态变化，不播报每个流式 token。核查浅色及深色对比度、macOS 标题栏留白、Windows 窗口边框、窄窗口、焦点可见性和滚动范围。

<a id="implementation"></a>

## 实现归属

扩展现有实验性 Team UI 插件。无需独立 Dashboard 应用、新执行循环或平行对话存储。以下新文件是实现目标，尚未创建。

| 能力 | 现有归属／符号 | 建议修改 |
|---|---|---|
| 团队根及导航 | `client-ui-agent-team/src/client/mount.ts`、`registerAgentTeamUi`、`openTeammate` | 提取共享注入动作，注册团队右栏类型、正文和标题，使用 effect disposer |
| 现有头部入口 | `client-ui-agent-team/src/client/TeamAction.tsx`、`TeamAction` | 头部打开团队标签页，避免两套独立成员列表 |
| 分组规则 | 建议 `client-ui-agent-team/src/client/team-status.ts`、`classifyTeamMember` | 纯函数确定性分类，覆盖未知及优先级语义 |
| 右栏内容 | 建议 `TeamDashboard.tsx`、`TeamMemberRow.tsx`、CSS modules | 分组列表、选中成员、Lead 入口及紧凑任务区 |
| 数据生命周期 | 建议 `team-dashboard-store.ts` | 根 Session 范围订阅及清理，不保留全部成员对话 |
| 任务标识及摘要 | `agent-team/src/types.ts`、`task-view.ts`、`projection.ts`、`teamProjectionView` | 一致暴露 owner 标识，权威摘要独立补齐 |
| 文案及部署 | `client-ui-agent-team/src/client/locales.ts`、包 README 双语及 profile 组合 | 类型化双语标签、右栏依赖及激活要求 |

参考现有[文档预览注册](../../../packages/client/ui-sidebar-documentpreview/src/client/index.ts)的右栏接入方式，由 [AppFrame](../../../packages/client/ui-layout/src/client/AppFrame.tsx) 负责布局尺寸。实现时先核对右栏 tab 定义的精确生命周期 API，再添加依赖；不要为容纳团队数据修改布局几何逻辑。

<a id="acceptance"></a>

## 交付与验收

分三个可审查阶段实现：先补齐任务归属及共享根／导航，再提供支持原生成员且如实显示未知状态的右栏，最后在持久多引擎调度后端可用时接入摘要和交互标记。成员引擎、厂商和模型选择归持久团队方案负责，不在 Dashboard 中发明独立选择器。

| 验收领域 | 必要证据 |
|---|---|
| 分类 | 每个优先级、混合任务、无任务空闲、完成后新输入、失效状态及删除任务 |
| 导航 | Lead 到成员再到兄弟及 Lead，输入目标正确，草稿和滚动保留，离开团队释放订阅 |
| 生命周期 | 创建中、失败但历史可读、Session 缺失、重连、插件卸载及订阅清理 |
| 交互 | 成员授权／提问、定向中止、输入排队、恢复失败和投递不确定恢复 |
| 产品输出 | 分组列表及导航的无密钥录制会话快照，先原生，外部引擎接通后逐个覆盖 |
| 展示 | Browser 及 Desktop、浅深主题、键盘、窄窗口、系统窗口边框、大列表及有界订阅 |

## 开发备注

待定产品选项：任务板放在成员列表下方，还是作为第二个内部标签页；只有后端接收及幂等规则明确后才增加直接唤醒／重试。本文没有已执行 UI 验收或运行时实现。现有源码事实已通过所链接代码核对，实现需要补充上述验收证据。
