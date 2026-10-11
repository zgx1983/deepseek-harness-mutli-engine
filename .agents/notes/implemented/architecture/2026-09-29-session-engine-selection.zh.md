# Agent Note：会话引擎选择——仅日志事件，分发后不可变

状态：已实施

[English](2026-09-29-session-engine-selection.md) | 中文

## 问题

主聊天必须能在会话生命周期内选定一个执行引擎（原生循环、Claude SDK 引擎或 Codex 引擎）并保持不变：引擎决定会话如何执行，历史已存在后再更改等于重放引擎无法执行的工作。引擎还决定模型选择——不同引擎通过不同 endpoint 服务不同 provider（Codex 引擎经其 OpenAI 兼容 endpoint 访问 GPT 模型；原生循环服务常规 LLM 注册表）。引擎标识必须持久化（跨重启与恢复）且独立于 LLM provider/model。

## 决策

**引擎选择持久化为仅日志的 `engine/selected` 会话事件，而非会话头字段。** 头部字段新增会被 `verify-persistence-changes` 归类为必读根上的 `optional-property-added`，`requiresVersionBump: true`，迫使 Session 格式版本升级并新增相邻迁移包。新增可合并扩展的事件根归类为 `root-added`，`requiresVersionBump: false`（允许同版本），生成的 `KNOWN_SESSION_EVENT_TYPES` 集合吸收它，仓库内读取方不会拒绝该日志。设计的持久化 `engine/selected` 记录（`engineId, adapterVersion, historyMode, environmentRef`）直接映射事件载荷；当前只写 `engineId`。

**每个会话一个引擎，只解析一次，首次分发后不可变。** `SessionCreateRequest.engineId` 指定已注册引擎；省略时解析部署默认（原生循环）且不记录事件。`selectEngine` 固定初始路由：仅在会话尚无引擎且无 `turn/start` / `user/message` / `request/header`（未分发任何工作）时成功，追加 `engine/selected`，此后不可变——冲突重选返回 `session/engine-conflict`，已分发会话返回 `session/engine-locked`，未知引擎返回 `engine/not-found`。恢复与显式 id 采纳读回事件（`engineFromEvents`），冲突的调用方覆盖以 `session/engine-conflict` 拒绝。缺少事件的旧会话使用已记录的原生兼容规则，永远不能追溯选择引擎。

**引擎注册与 LLM 工厂是独立关注点。** `ctx.agents.registerEngine(id, definition)` 声明名称、能力模式（`textStream`、`steering`、`resume`、`fork`，以及审批/用户输入/附件）、引擎路由的 endpoint id，以及可选的引擎自有 `AgentFactory`；`create`/`resume` 在引擎声明工厂时经其路由。原生引擎由 `agent-loop` 与 `setFactory` 一同注册。

**模型注册是 endpoint 感知的。** provider 适配器在 `providerInfo` 上声明具名 endpoint；模型可在 `listModels` 条目上收窄可达 endpoint 集合。`providerServesEngine`/`modelServesEngine` 把模型目录过滤为活跃引擎可路由的 provider 和模型；endpoint 集合为空的引擎（原生）可达全部。

## 后果

`engineCatalog()` 列出已注册引擎；`modelCatalog(engineId)` 按引擎 endpoint 过滤。GUI 编辑器在模型座位旁显示引擎选择下拉（`conversation.input.engine`），会话引擎固定后禁用，按会话的模型目录经 `engineSelection` 投影按引擎 endpoint 过滤组和模型。Codex 主聊天引擎（`registerCodexEngine`）注册 `codex` 引擎并经 app-server 协议驱动 turn；Claude 主聊天引擎（`registerClaudeEngine`）注册 `claude` 引擎并经一个受管 CLI 进程以流式输入模式驱动官方 Agent SDK，捕获 SDK session id 供后续恢复关口使用。两者都把可观察内容记录为仅日志的 `engine/input-submitted`、`engine/item-settled`、`engine/turn-settled` 事件（声明在 `dsh-session` 的公共读取方上）；steering、注入、fork、审批与原生恢复在设计规定的固定版本证据关口通过前保持禁用。已记录两条同版本持久化确认（`2026-09-29-agent-engine-selected`、`2026-09-29-agent-engine-codex-events`）。

## 备选方案

- **引擎放 `SessionHeader`**——持久且客户端易读，但一个可选字段就要 Session 格式版本升级与相邻迁移包；改用事件。
- **引擎选择作为工厂全局或按进程默认**——无法按会话、无法不可变；否决。
- **外部引擎内容经原生 `assistant/message` 事件路由**——会编造引擎从未产生的模型 step；Codex 引擎改为发出 provider 中立的引擎事件，专用会话投影作为后续关口。
