# 主 Agent 引擎详细设计

[English](detailed-design.md) | 中文

状态：待实施设计参考，不代表现有功能。负责人：主 Agent 引擎实施者与架构评审者。创建：2026-09-29。复审或到期：2026-10-29。实施后的归档目标：架构、核心子系统及引擎包文档。到期需要复审，不自动删除。

<a id="summary"></a>

## 概要

本提案参考定义路由、持久化和生命周期义务。先阅读[概览](overview.zh.md)。下文 API 名称均为拟议名称，不是现有导出。实施时可统一调整名称，但必须保持规定行为并更新全部消费者。

[端到端计划](end-to-end-plan.zh.md)补充用户要求的首条消息锁定、具体源码缺口、SDK 参数路由及恢复任务包；其选择规则替代下文创建时锁定规则。

<a id="contents"></a>

## 目录

- [注册与选择](#registration-and-selection)
- [共享运行时](#shared-runtime)
- [持久化数据](#durable-data)
- [输入与恢复](#input-and-recovery)
- [事件与展示](#events-and-presentation)
- [引擎适配器](#provider-adapters)
- [兼容性与错误](#compatibility-and-errors)

<a id="registration-and-selection"></a>

## 注册与选择

`AgentEngineId` 使用品牌字符串。`registerEngine(id, definition)` 返回 effect 管理的 disposer 并拒绝重复 ID。definition 包含 `AgentFactory`、能力声明和 provider 自有模型解析。卸载时先拒绝新工作，再取消并等待其所属 Agent 退出，最后移除注册。一个 provider 卸载不得停止其他 provider 的 Agent。

创建参数单独接受 `engineId`，模型 `provider` 保持 LLM 含义。按显式请求、preset 选择、配置默认值的优先级只解析一次。发布前校验 preset 兼容性、模型选项和执行环境。分发任何外部输入前持久化解析后的引擎。恢复使用已保存标识并拒绝冲突的调用方覆盖。缺少引擎标识的旧会话采用明确记录的原生兼容规则，不能使用当前默认值。

能力使用明确模式：`textStream = delta | item`、`steering = active-turn | unsupported`、`resume = native | unsupported`、`fork = native | unsupported`，以及审批、用户提问和附件支持。首版仅在空闲且 provider 校验成功时允许切换模型。不支持的请求在改变 inbox 前失败。已安装和认证就绪分开表示；列出引擎不得启动引擎或触发付费工作。

模型注册是 endpoint 感知的。provider 适配器注册时声明一个或多个具名 endpoint；endpoint 只命名 base URL 和认证引用，不保存凭证值，一个 provider 可在一个或多个 endpoint 上服务多个模型。引擎 definition 声明其路由的 endpoint id。会话解析出的引擎因此决定其模型目录和调用路由可使用哪些 provider endpoint：原生引擎服务原生 endpoint，Claude 引擎服务 Anthropic endpoint，Codex 引擎服务 OpenAI 兼容 endpoint，同一部署可承载三者且不共享路由。provider 未为当前引擎配置 endpoint 的模型不提供给该会话。

一个会话只解析一次引擎。解析结果在分发前持久化，且在整个会话生命周期内不可变：恢复使用已保存标识并拒绝冲突的调用方覆盖，创建后的引擎变更被拒绝，绝不静默迁移到其他引擎。

<a id="shared-runtime"></a>

## 共享运行时

注册表继续作为消费者入口。只提取与引擎无关的创建事务、持久化写入所有权、作用域设置与发布、inbox 投影注册和静止后销毁逻辑。原生模型 step 驱动器保留在 `agent-loop`。保留现有工厂的调用方创建取消、setup commit、创建事件顺序和回滚行为，不能另写一套简化生命周期代替。

`followup()` 每条消息排为一个 turn。`whenIdle()` 表示整个 Agent 静止，不代表某条消息成功。维护操作占用真正的空闲状态并暂存后续输入。`cancel(keepInbox)` 保留现有队列语义；外部确认或进程退出完成后才进入 idle。内部可含 starting、submitting、running、waiting-interaction、stopping，公共状态继续使用 idle/running，等待 UI 从待处理交互派生。

现有 `Agent.steer()` 和 `inject()` 承诺 next-step 时点，而外部引擎可能不暴露该时点。启用外部 provider 前增加按能力准入并审查所有直接调用者。不支持的适配器必须在入队前同步拒绝；不能静默转为下一轮或伪造模型 step。原生方法保持现有行为。依赖原生 step 的 Goal、guard 和注入器在组合 preset 时排除。

<a id="durable-data"></a>

## 持久化数据

下列载荷是拟议逻辑数据定义。跨进程 ID 在 TypeScript 中使用品牌类型，wire 解析校验字符串并恢复品牌。记录不得包含凭证、进程句柄或登录存储绝对路径。环境引用标识执行主机和工作区；存储引用必须可解析且不暴露秘密。

| 记录 | 必需数据 | 含义 |
|---|---|---|
| engine/selected | engineId, adapterVersion, historyMode, environmentRef | 不变的初始路由 |
| engine/bound | engineId, nativeSessionId, runtimeVersion, storageRef | 已确认原生标识 |
| engine/input-submitted | inputId, attemptId, contentRef, operation | 分发前持久化意图 |
| engine/input-accepted | inputId, attemptId, 可用时的 nativeTurnId | provider 提供的接收证据 |
| engine/input-unresolved | inputId, attemptId, reason | 无法确定投递结果 |
| engine/item-settled | nativeItemId, revision, category, payload | 可观察的已结算内容或活动 |
| engine/turn-settled | turnId, outcome, 提供时的 usage | 执行终态事实 |

`contentRef` 必须指向已提交用户内容或读取方可解析的不可变附件，不能是进程本地指针。发送前保存分发意图及内容。inbox 到 submission 的转换必须原子化，或能用同一 input ID 重建，防止崩溃丢失排队工作。持久化 outbox 投影派生 pending、accepted、unresolved。provider 一旦提供原生标识就立即记录；捕获标识前发生外部失败则明确保持 unresolved。

只有确认消费者不依赖模型 step 后才复用公共 turn/start 和 turn/end。不得用编造的模型请求数据发出原生 step/start、request/header 或 assistant attempt 记录。外部内容通过 provider 中立的 engine 事件及专用 conversation 投影展示，直到证明精确等价。投影注册位于原生 loop 外，使只读历史不依赖外部可执行程序。

必读 engine 事件及其纯投影定义随公共读取方发布，不能仅放在可选 provider 中。因此卸载执行插件仍能展示历史。不理解关键 engine 事件的读取方必须拒绝读取。遵循[持久化类型审查](../../cookbook/reviewing-persistence-type-changes.zh.md)；不能将关键事件标为 ignorable 来规避兼容性。结构性格式变化必须采用现有相邻版本迁移流程。

<a id="input-and-recovery"></a>

## 输入与恢复

创建先准备 DSH 会话及作用域 Agent，提交引擎选择，通过现有生命周期发布，然后允许队列运行。provider 延迟创建原生会话。恢复先取得 DSH 写入所有权，再打开原生状态，校验引擎、环境和版本支持，核对未完成投递后才接受新输入。单个 DSH 进程锁不能阻止其他原生 CLI 写入；首版需明确原生存储独占使用要求。

| 失败时点 | 必须行为 |
|---|---|
| submitted 记录之前 | 保留持久化排队输入 |
| submitted 之后、接收证据之前 | 核对状态；不得自动重发结果不确定的输入 |
| 原生 turn 完成、DSH 尚无终态记录 | 可获得的完成结果只导入一次，否则展示恢复未决 |
| 原生历史丢失 | DSH 历史保持可读；恢复明确失败 |
| provider 不可用 | 历史保持可读；执行失败且不回退其他引擎 |
| 审批期间取消 | 取消交互、拒绝迟到答复、停止并等待引擎退出 |
| 取消与成功竞争 | 保留已观察副作用及终态证据；应用已定义的首次取消原因语义 |

原生协议提供时，使用 session/turn/item 标识组成持久化去重键。协议缺乏稳定回放标识时，不承诺恰好一次导入，必须明确处理恢复选择。SDK 自动重试不等于允许重放可能修改文件的 turn。用户授权的新尝试使用新 attempt ID，保留未决的前次尝试。

<a id="events-and-presentation"></a>

## 事件与展示

临时增量更新实时文本；结算先提交完整可观察消息及 revision，再通知已提交结束。重连先读已提交投影，再带序列游标接入实时更新。临时序列缺口触发快照刷新。默认不逐 token 持久化，也不能编造 provider 未公开的隐藏推理、完整提示、工具输出或用量。

外部命令、文件修改和工具使用专用卡片，包含执行来源和原生 item ID。这些是观察记录，绝不能调用 `ctx.tools.execute`。审批卡片引用 session、turn、request 标识，只提供 provider 支持的选项并只结算一次。重启后只有重新确认的原生待处理请求才可答复，旧 UI 请求标为过期。

新聊天 UI 首先展示引擎选择下拉，列出全部已注册引擎。选定后固定该会话引擎，随后的模型下拉只显示配置了支持该引擎 endpoint 的 provider 和模型。已有会话显示固定引擎且不可修改。模型目录、校验及推理选项经引擎 definition 路由，不将外部模型名称送入 `ctx.llm`。UI 使用本地化文本解释不支持操作和未决投递。所有入口包括两套 DSH SDK 执行相同校验并暴露相同终态。

<a id="provider-adapters"></a>

## 引擎适配器

Claude 使用官方 query/session API，捕获明确 session ID，为可恢复聊天启用持久化。转换可观察消息、终态结果以及权限和用户输入回调。保留现有受管 spawn 接入。声明中断、增量输入和接收证据能力前，必须按固定 SDK 验证。`canUseTool` 不是全工具策略 hook；需要检查全部工具时单独评估 `PreToolUse`。

Codex App Server 适配 initialize、thread 创建与恢复、turn 启动与中断、通知及服务端请求。逐一按固定协议验证方法。复用已校验的 wire 解析和受管进程所有权，但主会话移除 ephemeral 与拒绝全部交互的假设。初期优先每个存活 DSH 会话拥有一个进程；共享进程池需另行设计所有权。可选 TypeScript SDK 通信方式仅暴露已验证方法，发布前必须建立受支持的进程管理方案。Codex 引擎通过固定版本的 app-server 协议原生访问 GPT 模型：thread 路由遵循 Codex 自身模型配置，引擎 definition 声明其服务的 OpenAI 兼容 endpoint。引擎绝不将外部模型名称路由进 `ctx.llm`。

配置管理运行时选择、权限模式、环境覆盖、工作目录策略和退出宽限。认证保留在 provider 支持的凭证存储中，只记录引用，不记录秘密。固定运行时载荷缺失时不得静默使用主机可执行文件。不能声称 SDK 原生工具执行经过 DSH 文件系统或沙箱 provider；分别验证进程约束与引擎原生策略。

<a id="compatibility-and-errors"></a>

## 兼容性与错误

首版排除同会话跨引擎切换、对外部会话任意 DSH 事件前缀分支、原生状态跨主机迁移、在外部 turn 外套 DSH 请求重试及自动导出 DSH 工具。不支持的 fork 必须在原生 `buildForkSeed` 处理前拒绝。后续原生 fork 需要验证 UI 选择位置到引擎 checkpoint 的映射。

暴露稳定错误：引擎不可用、能力不支持、引擎不匹配、原生状态丢失、投递未决、运行时不兼容和写入冲突。原始 provider 错误保留在受保护诊断中，用户消息经过清理。没有用量时不能编造 token 费用。取消保留已发生的外部副作用，取消不等于回滚。
