# 功能迁移与迭代清单

> 范围：主会话引擎迁移、个人项目看板及近期界面改动；当前功能与验证状态见[功能清单](docs/features.zh.md)。

> 更新日期：2026-10-11。本文件记录迁移范围、安装清单和验证状态；后续迁移须逐项核对，不以单个 worktree 的文件差异代替完整清单。

## 最近改动（2026-10-09 至 2026-10-11）

| 功能 | 当前用途与状态 |
|---|---|
| 个人助理插件改为项目看板 | 旧任务、Todo、个人知识、助理对话和协调会话管理均已废弃；当前展示今天与近七天的项目、会话活动及用量，用户已确认加载可用。完整条目见[功能清单](docs/features.zh.md)。 |
| 三引擎 token 统计与大数显示 | Native、Codex、Claude 的已报告分项及累计差额纳入统计，排除 fork 继承事件；万、亿均保留两位小数。构建与数字格式验证通过，真实引擎用量对账待验收。 |
| 可选归档总结与提交时序 | 默认仅归档；勾选后由原引擎、原会话后台直接追加项目 `CHANGELOG.md`。总结结束后在维护阶段内确认文件并提交归档，失败保持未归档。2026-10-11 类型检查、协调构建通过，真实归档流程待验收。 |
| 最近列表与对话项目标识 | 最近列表显示项目名称，旧助理执行会话正常显示且隐藏标题后缀；对话头部显示所属项目。协调构建通过，界面验收待完成。 |
| Desktop 侧栏预览与 Team 流程展示 | 收起侧栏支持悬停预览；Team 画布与对话工作流计划卡片已实现。协调构建通过，最新界面交互待验收。 |
| 中间终端插件移除 | `dsh-center-terminal` 实现已删除，旧外部 profile 的安装记录需单独核对。 |

## 历史可用版本基线

已记录版本标签：`usable-2026-10-08.1`，分支 `migrate-main-engines`。主体是个人助理任务闭环、Todo 与长期知识（执行配置与快照、交付制评审、三引擎受限工具与会话导航、中栏三入口、右侧常驻对话、Markdown 知识目录；见下方对应条目），同时保存 `usable-2026-10-05.1` 之后工作区累积的全部源码与文档改动：session-manage 新包（`packages/api/tool-session-manage`、`packages/client/ui-session-manage` 及快照）、Agent Team 与 Claude/Codex 子代理包改动、session total-tokens 与 Team 受控调度持久化变更文档、子系统文档更新，以及本地构建脚本（`scripts/build-local.ts`、`build-quiet`）与桌面 dev 脚本调整。标签保存仓库源码、文档和测试，不包含 `.zcode`、`sort-algo/`、构建日志、构建产物及外部用户配置。后续使用 `git diff usable-2026-10-08.1` 比较工作区，使用 `git diff usable-2026-10-08.1 HEAD` 比较已提交改动。

上一版本标签：`usable-2026-10-05.1`，分支 `migrate-main-engines`。保存当前 Team 面板和任务依赖展示、个人助理改动、引擎配置改动，以及 `session_create` 实现删除和 Claude/Codex `/startup` 源码映射修复。Web、Host/Client 与 Desktop 完整构建通过，217 个 Cordis 配置检查通过；各功能的真机验收限制以对应条目为准，Electron 子进程被终止的原因尚未确认。后续使用 `git diff usable-2026-10-05.1` 比较工作区，使用 `git diff usable-2026-10-05.1 HEAD` 比较已提交改动。

版本标签：`usable-2026-10-04.2`，分支 `migrate-main-engines`。包含上一基线后的 Team 面板、成员计时、引擎命令，以及 Team 初始共享任务和外部引擎模型投影修复。最近修复通过 65 项定向测试、Team 会话快照和 Host 类型检查，Host 与 Desktop 产物已构建；本次构建后的 Desktop 尚未重启验证。

版本标签：`usable-2026-10-04.1`。基线包含当前主会话引擎迁移、已安装插件的仓库文件、Agent Team 合并入口与模型路由，以及 F22/F23 的 Claude 容量和首次启动恢复修复。完整构建已通过，Claude 真实 SDK/CLI 的本地 keyless 回归已通过，Desktop 已使用共用 `~/.dsh` 配置启动；各插件尚未完整验证的功能仍按下方条目记录。

后续迭代使用 `git diff usable-2026-10-04.1` 查看工作区相对此基线的改动，使用 `git diff usable-2026-10-04.1 HEAD` 查看已提交改动。Git 标签保存仓库源码、配置模板和测试；外部 `dsh-start`、Electron 缓存及 `~/.dsh` 中的配置和用户数据按 F18/F19 单独核对。

## 已有相关文档（本清单不做重复详述，只做索引）

| 文档 | 覆盖范围 |
|---|---|
| `.agents/notes/implemented/architecture/2026-09-29-session-engine-selection.md` | 已提交部分的引擎选择决策（registry、`engine/selected` 事件、endpoint-aware 路由） |
| `docs/main-agent-engines.md` | 三种主会话引擎的实现/迁移参考（功能 → 文件/符号映射） |
| `docs/scratch/main-agent-engines/{overview,detailed-design,implementation-plan,end-to-end-plan}.md` | 主引擎设计/计划 |
| `docs/scratch/main-agent-engines/team-dashboard.md` | Team Dashboard 设计（本次已实现主体，见 F8） |
| `docs/scratch/main-agent-engines/persistent-agent-teams.md` | 持久化多引擎 Team 设计稿；部分能力已落地，不能按旧稿判定当前实现状态 |
| `issue-recent-sessions-subagent.md` | 历史 issue：子会话排除已迁移修复，见 F16 及插件清单 |

---

## F1. 可插拔主会话引擎骨架

- Agent 引擎注册表：`agents.registerEngine/listEngines/getEngine/requireEngine/resolveEngineId`（`packages/core/agent/src/engines.ts`、`index.ts`）。
- 引擎选择持久化为 log-only `engine/selected` 会话事件（避免 Session 格式版本升级）。
- `selectEngine` 初始路由 + `engineSelection` 投影 + 作曲器引擎选择（`EngineSelect`）；固定会话的静态显示见 F17。
- endpoint-aware 模型路由：provider/model 声明可达端点，按引擎过滤模型目录（`modelCatalog(engineId)`、`providerServesEngine/modelServesEngine`）。
- Codex（app-server）与 Claude（Agent SDK）主引擎的初版骨架。

## F2. 引擎可执行化：EngineTurnDriver 与外部回合投影（核心）

- `EngineTurnDriver` 契约（`prepare/run/close` + `contextWindow`），`AgentEngineDefinition.driver`（`core/agent/src/engines.ts`）。
- `ReactLoopAgent.externalTurn()`：非 native 引擎的回合领取 inbox 消息、写 `engine/input-submitted`、把驱动 `StreamChunk` 投影为共享转录流、发布 `request/context`、结算 `assistant/message` + `engine/turn-settled`（`core/agent-loop/src/agent.ts`，新测试 `external-context.spec.ts`）。
- `Agent` 契约扩展：`executionEngineId`、`prepareExecution()`、`closeExecution()`；注册表 disposer 会先取消并关闭仍在运行的引擎 agent。
- `engine-records.ts`（新）：`nativeBindingFor/recordNativeBinding`（原生会话身份持久化）、`assertSettledEngineInputs/acknowledgeEngineRecovery`（投递账本，崩溃后拒绝重放未确认输入）、`engineActivityRecorder/engineSubagentRecorder`（活动/子代理记录）、`engineFailure`（错误脱敏）。
- `engine/selected` 事件上移到 `core/session` 公共词汇表（+`adapterVersion/historyMode/environmentRef`）；新增 `engine/input-submitted`、`engine/item-settled`、`engine/turn-settled`。
- `createManaged/resumeManaged`：引擎 factory 不经递归的共享生命周期创建/恢复。

## F3. 引擎选择语义调整 + 新斜杠命令

- 语义从「创建即不可变」改为「**首条用户消息前可反复改选，首条消息锁定**」；`engineSelection` 投影加 `locked` 标志（stateVersion 1→2）；UI `EngineSelect` 相应改为锁定前可切换。
- 空会话 resume 时非 native 草稿复位为 native。
- `/model`：升级为一等内置命令（host 端 `session-controller/src/model-command.ts` 注册本体，ui-commands/ui-model-selection 只做装饰）；catalog 按当前引擎过滤。
- `/engine-recover`：确认 `EngineDeliveryUncertainError` 后关闭执行、下次 prompt 走原生历史恢复。
- `prompt` 增加能力门控（steering/附件不支持时报 `unsupported-capability`），外部引擎 idle 时预 `prepareExecution`。

## F4. Claude 主引擎完整实现（`subagent-claude-code`）

- `ClaudeExecutionDriver implements EngineTurnDriver`；能力从全禁用升级为 `resume: 'native'`、`approval: true`、`userInput: true`。
- 端点解析（新 `endpoint.ts`，`anthropic-api` 端点，经 `dsh-credentials` 解析密钥）。
- 权限预设 → 原生 permissionMode/sandbox 映射；只读策略裁剪工具白名单；`canUseTool` 接入 approval 服务；`AskUserQuestion` 接入 user-questions。
- MCP elicitation（新 `elicitation.ts`）：表单/URL 确认投影为用户提问，密码字段直接拒绝。
- SDK 流式 partial → `StreamChunk`；usage/contextWindow 上报；原生 session id 捕获与 resume；SDK 内部子代理观察投影。
- 新 Cordis 插件入口 `startup.ts`（`main-engine-claude`）。

## F5. Codex 主引擎完整实现（`subagent-codex`）

- `CodexExecutionDriver`；端点解析（`openai-compatible`）。
- 新 `main-wire.ts`：持久主线程协议（`thread/start|resume`、`turn/start`、增量流、tokenUsage、server 请求按 thread/turn 归属路由）。
- 新 `provider-config.ts`：每路由 HTTP 头/凭据引用/重试/超时/子代理模型等编译为 `-c key=value`。
- 新 `model-catalog.ts`：从 LLM 注册表过滤生成本地模型目录并用 `model/list` 校验。
- 新 `storage.ts`：按 sessionId 哈希的独立 `CODEX_HOME`，legacy rollout 迁移支持 resume。
- 新插件入口 `startup.ts`（`main-engine-codex`）。

## F6. 端点/凭据声明管道

- `LlmEndpointInfo`（id/name/baseUrl/`credentialRef`——凭据只存引用不存值）；`LlmProviderInfo.endpoints`、`LlmModelInfo.endpoints`。
- `llm-deepseek` / `llm-pi-ai`：新增 `claudeCodeURL`/`codexURL` 配置，据此声明 `anthropic-api`/`openai-compatible` 引擎端点；配置热更新触发重新注册。
- 设置 UI：新 `EngineUrlFields.tsx`，新建/编辑自定义厂商时可配置两个引擎 URL（`ui-settings-models`）。

## F7. 引擎可观察性

- ui-chat：新 `engine-activity` 会话节点——引擎内部工具调用按 `nativeItemId` 聚合、原地更新，渲染为普通工具卡片（只读，不产生可执行工具事件）。
- ui-trajectory：对应定义，同一事件系列在账本视图折叠为 tool 行。
- agent-team：新 `engineSubagents` 投影（stateVersion 1）——引擎内部子代理以只读快照进入会话投影；断连时降级为 `unknown` 而非伪装完成。

## F8. Team Dashboard 右侧栏（主体已实现）

- Team 从会话头部临时弹层升级为右侧栏常驻面板：`TeamDashboard.tsx` 注册 `sidebar.right.pane.tab`，头部 TeamAction 加「在右侧查看团队」入口。
- 新 `member-status.ts`：成员状态分类（failed/unknown/running/pending/completed/idle/unstarted/provisioning）；`Roster.tsx`/`MemberCard`/`TaskTiming.tsx` 共享组件。
- `EngineSubagents.tsx`：引擎子代理分组展示 + 只读详情。
- 后端任务已有 `ownerId: SessionId`；客户端 `TeamTaskView` 目前只暴露 `ownerName`，Dashboard 按名字关联任务。待完善的是客户端归属 ID 透传，不是重建后端 owner 字段。
- 面板已复用共享 Session store；专属独立 store 是设计改进方案，并非当前面板缺少状态管理。未读徽章、搜索过滤和分组折叠尚未实现。

## F9. Team 任务计时

- `TeamState.taskTimes`：记录任务首次进入/最近离开 `in_progress` 的时间；`TeamTaskView` 增加 `startedAt/endedAt`（stateVersion 4→5）；任务板展示起止时间与耗时（运行中每分钟刷新）。

## F10. 会话壳复用与主面板-会话绑定（Team 布局前提）

- ui-conversation：`conversation.shell` 工厂槽（`registerConversationShell`）；`workspaceSelection: 'hidden'` 选项——专属会话面板可复用完整会话壳而无需选工作区。
- ui-sidebar-right：`registerPanelSession(panelId, sessionId)` + 可观察 `panelSessions`——活动主面板绑定会话时右栏显示对应会话内容。
- session-controller 客户端：`excludeFromCatalog(id)` 引用计数排除——插件自有会话可从目录隐藏。

## F11. 共享 home 配置

- config-editor：`sharedEntries` 配置——列出的条目读写/锁定目标改为 `$DSH_HOME/cordis.patch.yml`，跨 profile 生效（典型用途：引擎/厂商端点）。
- app-boot：`readProfilePatches()` 新增 `homePatches` 注入参数，供写入前校验。

## F12. 权限/审批配套

- permission-presets：新 `effective(session): PresetSpec`（解析含 custom 选择在内的生效旋钮，引擎 prepare 依赖）。
- user-approval：策略变更通知跳过 `steering: 'unsupported'` 的引擎会话。

## F13. 桌面端 macOS 未签名打包（独立功能线）

- 原仅 Windows 的 `--unsigned` 扩展到 macOS arm64/x64：8 个新 npm 脚本；unsigned 时跳过签名身份/公证/keychain/release record，原生运行时不签名；产物输出 `unsigned-artifacts/`、带 `-unsigned` 后缀；4 个 spec 全面更新。

## F14. 杂项修复与工具链

- agent-loop 工具调度器内部失败时补记显式错误结果（`TOOL_SCHEDULER_FAILED`），不再让未决调用悬空。
- `TOOL_RUNTIME_SCHEDULER` 改为 `Symbol.for` 进程级键（兼容多副本 runtime/profile）。
- gateway 客户端：业务参数尾部可选参数可按位置省略（`/model` 等命令的 wire 层支撑）。
- web-app bundle：默认装载 `main-engine-claude` / `main-engine-codex` 两个 startup。
- `tool-cordis/src/api-catalog.ts`：API 目录同步新增引擎相关条目（`agents.registerEngine/listEngines/createManaged/resumeManaged`、`sessionController.selectEngine/engineCatalog`、`modelCatalog(engineId?)`、`permissionPresets.effective()`、`AgentEngine*`、`EngineTurnDriver`、`LlmEndpointInfo` 等类型）。
- `scripts/gen-cordis-catalog.ts`：新增 6 个类型链接（`AgentEngine*` → core.md，`EngineCatalog`/`SessionSelectEngine*` → session.md）与 `Disposable` 基础类型；`scripts/type-equiv.manifest.json`：新增 `LlmEndpointInfo` 类型等价条目。
- `pnpm-lock.yaml`：subagent 双包新增对 `dsh-agent`/`dsh-app-boot`/`dsh-permission-presets`/`dsh-user-approval`/`dsh-user-questions`/`dsh-credentials`/`zod` 的依赖；`client-ui-agent-team` 与 `web-app` 新增 `dsh-client-ui-sidebar-right`；外部新包仅 `@types/ws`、`glob` 及 micromark 传递依赖。
- `packages/client/ui-workspace`：仅测试 mock 增加 `excludeFromCatalog` 声明（接口跟随，无行为变化）。

## F15. 文档

- 新增 `docs/main-agent-engines.md`（中英双语）：主会话引擎实现/迁移参考。
- subsystem 文档同步：core（引擎注册表 + driver）、session（4 个引擎事件 + selectEngine/engineCatalog + 锁定语义）、llm-streaming（`LlmEndpointInfo`）、agent-team（`startedAt/endedAt`）、permission-presets（`effective`）；config-catalog、persistence-catalog、module-graph、architecture、development 相应更新。
- 新增 scratch 设计文档：`end-to-end-plan`、`persistent-agent-teams`（未实现提案）、`team-dashboard`。

## F16. 本地验证产物

- `apps/web/tests/*.png`（10 张）+ `tmp-*.mjs`：设置/模型面板手工验证的截图与 Playwright 调试脚本。
- `issue-recent-sessions-subagent.md`：已记录的 issue（已在 plugins/dsh-recent-sessions 移植版中修复）。

## 迁移插件安装清单

以下六个可选组合包仍列在本清单中；安装基线来自 2026-10-04，功能列按当前源码更新，旧 Desktop profile 的安装状态需单独核对。当前安装使用本仓库源码目录的本地链接；核心能力使用当前构建，不恢复旧 profile 中的 `0.1.7-rc.2` 覆盖包。安装状态不等同于完整功能验证。

| 包名 | 功能与源码位置 | 已有验证与待验收事项 |
|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | Agent Team、团队工具及团队界面；[源码](packages/experimental/agent-team-profile/) | 团队服务、工具和 Client 插件均为 ACTIVE，依赖服务齐全 |
| `@deepseek-ai/dsh-subagent-claude-code` | Claude 委派 provider；主会话 startup 由 Web 基础组合加载；[源码](packages/subagent/subagent-claude-code/) | provider 与 startup 均为 ACTIVE |
| `@deepseek-ai/dsh-subagent-codex` | Codex 委派 provider；主会话 startup 由 Web 基础组合加载；[源码](packages/subagent/subagent-codex/) | provider 与 startup 均为 ACTIVE |
| `dsh-personal-assistant` | 只读项目看板：今天与近七天活动、项目及会话明细、三引擎已报告 token 用量；[源码](plugins/dsh-personal-assistant/) | 协调构建通过，用户确认加载可用；完整用量对账待验收，旧助理测试不作为看板验收证据 |
| `@deepseek-ai/dsh-client-ui-recent-sessions` | 最近会话区块，显示项目名称，排除归档、空白与 subagent 会话；旧助理执行会话正常显示并去掉标题后缀；[源码](plugins/dsh-recent-sessions/) | Client/Host 构建通过，最新显示交互待验收 |
| `dsh-keep-awake` | macOS 保活，使用托管 `caffeinate` 进程；[源码](plugins/dsh-keep-awake/) | 已安装，重启无启动错误；保活进程及终端活动跟踪待验证 |

`dsh-keep-awake` 来自切换分支前保存的 stash，而非 `e2a7`；后续迁移必须同时检查 stash 的未跟踪文件和旧 Desktop 安装清单。个人助理插件当前依赖标准会话查询、工作区和界面服务；旧任务工作台的工具与存储依赖已移除，升级说明见[个人助理改为项目看板](docs/upgrade-guide/v0.2.0-rc.2/personal-assistant-dashboard/guide.zh.md)。

最近会话的配套能力包括 `sidebar.recent` 插槽、`ui-conversation` 的 `engineSelection: 'hidden'` 外壳选项，以及 Session 客户端创建请求的 `engineId` 透传。上述目录中的 README 是具体行为与限制的文档入口。

## F17. 固定会话只显示当前引擎

首条用户消息前仍可通过下拉菜单反复选择引擎。会话 `locked` 或引擎目录 `fixed` 后，作曲器只显示当前引擎名称，不渲染按钮、下拉箭头或菜单，也不列出置灰的其他引擎。已有消息但没有引擎记录的历史会话沿用 Native。

- 实现：[EngineSelect.tsx](packages/client/ui-model-selection/src/client/EngineSelect.tsx) 与 [样式](packages/client/ui-model-selection/src/client/EngineSelect.module.css)。
- 验证：[组件测试](packages/client/ui-model-selection/tests/engine-select.client.spec.tsx) 5 项通过，覆盖新会话选择、选择后固定、两种固定状态及目录加载失败；类型检查、针对性 Lint 和双语配对通过。
- 构建后的 Client 包已更新，Desktop 已重启加载；后续迁移应同时核对源码与实际运行的 Client 产物。

## F18. 共用 Electron 运行时与已有构建产物

Electron 缓存位于 `~/.cache/deepseek-harness/electron/<版本>/<平台>-<架构>`，可通过 `DSH_DESKTOP_ELECTRON_CACHE_DIR` 改写。首次可导入本机已有 Electron，后续直接复用；暂存目录和原子发布防止并发读取不完整运行时，复制时保留 framework 的相对符号链接。

- 实现：[development-electron.ts](apps/desktop/scripts/development-electron.ts)，由 [dev.ts](apps/desktop/scripts/dev.ts) 解析共享可执行文件。
- 验证：[缓存测试](apps/desktop/tests/development-electron.spec.ts) 覆盖并发、版本/架构隔离、删除原依赖目录后复用、相对链接及非法缓存标识；相关 4 项测试、Host 类型检查和针对性 Lint 通过，实际连续调用复用同一路径。
- `start:desktop` 跳过编译，但仍执行项目和主运行时准备；本机 `~/.local/bin/dsh-start` 直接启动已准备好的 Desktop 产物。该外部脚本不在仓库内，迁移源码不会自动迁移它。

## F19. Desktop 共用数据目录与重置记录

本机 `dsh-start` 使用 `$DSH_HOME` 存放配置及会话，Electron 用户目录为 `$DSH_HOME/electron-user-data`，默认 home 为 `~/.dsh`；当前源码开发命令仍默认使用工作区的独立目录，需通过环境变量显式选择共用目录。当前外部脚本的主运行时资源仍指向 `e2a7` 的已准备产物，后续移除该 worktree 前必须替换此路径。

清空登录状态或仅清空 Electron 用户目录未解决 `accountController` 不可用。备份并重置整个 DSH home 后 Desktop 正常启动；尚未确定旧 profile 中哪项配置或插件覆盖是具体原因。原 home 备份为 `~/.dsh.backup-20261004-062540`，不应直接恢复其旧版本核心包覆盖。

## F20. Agent Team 合并子智能体入口

启用 Agent Team 投影时，Team 控件和 Claude/Codex 原生子项共用 `TeamAction` 一个标题栏入口；Team 投影存在时隐藏独立的子智能体计数入口。面板提供 Team roster、任务看板与原生子项状态和只读输出；Harness 子会话目录后经 F25 并入成员分区并最终移出面板；普通会话仍保留原子智能体入口。

- 实现：[TeamAction.tsx](packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx)、[mount.ts](packages/experimental/client-ui-agent-team/src/client/mount.ts)；Host 对应投影由 [agent-team](packages/experimental/agent-team/src/projection.ts) 提供。
- 验证：[TeamAction 组件测试](packages/experimental/client-ui-agent-team/tests/team-action.client.spec.tsx) 覆盖单一面板中的 Team 控件与子智能体目录；[子智能体会话 UI 测试](packages/client/ui-subagent/tests/conversation-ui.client.spec.tsx) 覆盖 Team 投影存在时隐藏独立入口。当前实现细节见[主会话引擎迁移参考](docs/main-agent-engines.md#native-child-status-implementation)及[Team UI 包文档](packages/experimental/client-ui-agent-team/README.md#native-child-status)。

## F21. Agent Team 指定 Claude/Codex 模型路由

`list_teammate_models` 将本地厂商和模型的完整 ID、显示名及兼容引擎作为工具结果发送给主模型并记录到会话。主模型根据用户的简称和需求选择完整厂商、模型和引擎 ID；有歧义时询问用户。本地不得新增模糊匹配或自动替换模型。该工具同时通过 Claude/Codex Team MCP 提供。

`spawn_teammate` 在模型同时指定厂商和模型时，将两项原样传给子 Agent；两项都省略时才继承 Lead 路由。工具不按本地模型目录模糊匹配或替换名称。Claude 将选定模型传入 SDK；可选模型元数据解析失败时以指定名称继续。Codex 将目录未列出的选定名称原样加入隔离原生 `models.json`，元数据缺失时以该名称作为 ID 和显示名，并在当前驱动器存续期间保留此前选定的未列出模型，供 app-server `model/list` 校验及模型切换复用。

- 实现：[Team 工具路由](packages/experimental/tool-agent-team/src/index.ts)、[Claude 元数据回退](packages/subagent/subagent-claude-code/src/engine.ts)、[Codex 原生目录](packages/subagent/subagent-codex/src/model-catalog.ts)与[目录复用](packages/subagent/subagent-codex/src/engine.ts)。
- 回归覆盖：[Team 工具](packages/experimental/tool-agent-team/tests/tool-team.spec.ts)、[Claude 引擎](packages/subagent/subagent-claude-code/tests/engine-endpoint.spec.ts)、[Codex 目录](packages/subagent/subagent-codex/tests/model-catalog.spec.ts)及[Codex 引擎](packages/subagent/subagent-codex/tests/engine-endpoint.spec.ts)。

## F22. Claude 原生模型窗口容量与压缩阈值

Claude 主会话启动时，从选定提供方和模型的元数据读取 `context.contextWindow`，将完整容量传入原生进程的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，将 `Math.floor(contextWindow * 0.75)` 传入 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。必须保留乘以 0.75 的压缩逻辑；只传压缩阈值不能正确指定原生模型容量，也不能通过修改界面显示代替启动参数修复。容量不依赖模型名是否带 `[1m]`，模型名保持原样；元数据没有容量时，两个变量均省略，并清除部署或继承环境中的旧值。

- 实现：[模型元数据到启动规格](packages/subagent/subagent-claude-code/src/engine.ts)、[启动环境变量](packages/subagent/subagent-claude-code/src/main-adapter.ts)；完整说明见 [Claude 包文档](packages/subagent/subagent-claude-code/README.zh.md)。
- 回归：[启动规格测试](packages/subagent/subagent-claude-code/tests/engine-endpoint.spec.ts)、[容量及 75% 阈值测试](packages/subagent/subagent-claude-code/tests/engine.spec.ts)、[真实 SDK/CLI 测试及原生输出快照](packages/subagent/subagent-claude-code/tests/main-runtime.spec.ts)。真实 CLI 使用隔离的本地 API fixture，已验证自定义网关模型报告 1,048,576 tokens。

## F23. Claude 初始化后首次发送与原生恢复

命令发现或启动准备可在发送消息前记录原生会话 ID，但仅初始化不会创建可恢复的 Claude 历史。进程重建时保留这个 ID；只有已有 ID 且 DSH 日志包含 `engine/input-submitted` 或 `user/message` 时才使用 `resume`。尚未投递输入时以相同 ID 创建原生会话，避免启动时错误恢复不存在的历史，导致首条 prompt 被拒绝。已有投递记录时仍恢复原生历史，不能通过清空用户数据或创建新 ID 绕过恢复。

- 实现：[Claude 驱动器的恢复判定](packages/subagent/subagent-claude-code/src/engine.ts)。
- 回归：[端点切换与身份保留测试](packages/subagent/subagent-claude-code/tests/engine-endpoint.spec.ts)、[真实初始化后重启、首次发送及已有历史恢复测试](packages/subagent/subagent-claude-code/tests/main-runtime.spec.ts)；已复现并修复初始化后直接 `resume` 导致的 `No conversation found with session ID` 错误。

## 功能检查列表：Claude 窗口与启动恢复

每次迁移或修改 Claude 引擎后重新核对以下项目；勾选表示该次检查实际通过，不沿用此前结果。

- [ ] F22：配置容量经模型元数据、驱动器启动规格、SDK 环境和实际原生进程完整传递；不能仅核对界面上的窗口数值。
- [ ] F22：1,000,000 tokens 对应容量变量 `1000000`、压缩变量 `750000`；1,048,576 tokens 对应 `1048576` 和 `786432`。完整容量与压缩阈值不能互相替代，乘以 0.75 的逻辑保持不变。
- [ ] F22：无 `[1m]` 后缀的自定义网关模型也能使用配置容量；缺失容量时不保留上一模型、部署或父进程的两个窗口变量。
- [ ] F23：仅初始化或发现命令后关闭进程，再启动并发送首条消息成功；原生 ID 保留，首次投递前不使用 `resume`。
- [ ] F23：已有输入投递后切换端点或重启，恢复同一原生 ID 及历史；不清空配置、用户数据或会话来掩盖错误。
- [ ] 执行上述三份 Claude 回归测试，包含真实 SDK/CLI 的本地 keyless fixture 与容量输出快照；分别检查首次发送和已投递历史恢复。
- [ ] 构建引擎 Host 包、Client 包、Web 和 Desktop，核对实际运行的 `lib/startup.js` 包含两项窗口变量及恢复判定，避免只构建 Web/桌面外壳而继续加载旧引擎。
- [ ] 使用既有共用 `DSH_HOME` 和 `$DSH_HOME/electron-user-data` 启动；核对 profile 的本地包链接及实际加载路径，避免独立开发 home 的默认配置影响结果。

## F24. 子智能体成员起止时间

头部 Team 面板与右侧 Dashboard 的成员卡片从成员子会话 `subagentTiming` 显示首次开始、最近结束时间和墙钟耗时，不依赖成员是否创建共享任务。时间由持久 `turn/start`、`turn/end` 折叠；新轮次保留首次开始并清除旧结束，descriptor 重置继承的计时。累计活动时长仍为 `settledMs`，与包含轮次间空闲的墙钟耗时分开。投影缓存 `stateVersion` 升为 4，旧缓存从日志重建，不改变已提交的 Session 格式世代。

- 实现：[计时投影](packages/subagent/subagent/src/projection.ts)、[客户端类型](packages/subagent/subagent/src/projection-types.ts)、[成员卡片](packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx)、[Dashboard](packages/experimental/client-ui-agent-team/src/client/TeamDashboard.tsx)。
- 回归：[descriptor 与多轮计时](packages/subagent/subagent/tests/timing-projection.spec.ts)。同日 F25 将成员卡片与引擎子项的时间行从面板移除，开始／结束与耗时只在任务卡展示；`subagentTiming` 投影及其多轮折叠规则保持不变，仅供服务端与后续消费使用。

## F25. Team 面板收敛：任务看板与成员合并展示

「共享任务」分区更名「任务看板」（Task board），空板文案同步；仅改客户端词条，模型侧 shared-task 术语不变。「子智能体会话」分区并入「成员」：删除 `agent-team.subagents` 跨包插槽（声明、注册与 `TeamCatalogSlot.tsx`），面板只保留成员、任务看板与引擎子项；一次性子代理和嵌套子会话不再进入团队面板，普通（非 Team）会话的独立子智能体入口不受影响。成员卡片与引擎子项不再显示开始／结束时间行；「返回主会话」按钮移除；开始／结束时间与耗时只在任务卡展示。「任务看板」标题在两个表面常驻（空板显示计数 0 与空态文案）——首版实现空任务时在下拉隐藏标题，被误读为任务列表丢失，已修正。F20 的面板构成与 F24 的成员计时展示以本条为准。

- 实现：[TeamAction.tsx](packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx)、[TeamDashboard.tsx](packages/experimental/client-ui-agent-team/src/client/TeamDashboard.tsx)、[EngineSubagents.tsx](packages/experimental/client-ui-agent-team/src/client/EngineSubagents.tsx)、[locales.ts](packages/experimental/client-ui-agent-team/src/client/locales.ts)；[mount.ts](packages/experimental/client-ui-agent-team/src/client/mount.ts) 移除座位声明；[ui-subagent index.ts](packages/client/ui-subagent/src/client/index.ts) 移除插槽注册。
- 回归：[TeamAction 组件测试](packages/experimental/client-ui-agent-team/tests/team-action.client.spec.tsx) 覆盖合并面板、计时只在任务卡与无返回按钮；[子智能体会话 UI 测试](packages/client/ui-subagent/tests/conversation-ui.client.spec.tsx) 覆盖 Team 会话抑制独立入口不受影响。

## F26. 成员引擎标识

`TeamMemberProjection` 增加 `engine` 字段，从持久 provider 推导：`engine:` provider 命名空间携带引擎 id（`claude`／`codex`），其余 provider 为 `native`，Lead 恒为 `native`。推导在投影视图完成，投影状态 schema 不变（`stateVersion` 保持 5），不影响已存日志回放。成员卡名称后以括号显示引擎（弱化色），下拉面板与右侧 Dashboard 共用同一组件。引擎字段用开放 `string` 而非封闭联合，避免未来注册新引擎时 wire 严格校验把整个团队投影打成 failure。

- 实现：[类型](packages/experimental/agent-team/src/types.ts)、[投影推导 `memberEngine`](packages/experimental/agent-team/src/projection.ts)、[成员卡渲染](packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx)。
- 回归：[投影视图与推导断言](packages/experimental/agent-team/tests/projection-events.spec.ts)、[引擎显示断言](packages/experimental/client-ui-agent-team/tests/team-action.client.spec.tsx)。

## F27. 外部引擎 `/plan` 与子会话命令目录

- Claude：长连接 SDK Query 动态 `setPermissionMode`（`@anthropic-ai/claude-agent-sdk` 0.3.263 已核实）。`/plan` 进入原生 plan 权限模式，`off` 恢复部署解析的基础模式（委托时 `default`）；适配器签名不跟踪动态切换避免中途重启进程；`bypassAllowed` 跟随基础模式，保证重启后退出 plan 仍能恢复 bypass。
- Codex：随包 0.153.4 二进制已直接验证（静态字符串 + app-server 实时探针），与 `rust-v0.153.4` GitHub tag schema 不同步：`collaborationMode/list` 返回 Plan/Default 预设，`turn/start` 接受 `collaborationMode: { mode, settings: { model, reasoningEffort? } }`，`turn/settings/update` 不携带模式。`/plan` 以每轮 `turn/start` 参数携带、下一轮生效，`off` 显式回 `default`；`collaborationMode/list` 失败时不注册命令，手动输入返回明确的不支持原因。固定 Codex 版本变化时必须重新对照二进制核实。
- 模式状态：`engine/item-settled` category `mode` 记录（复用开放类别，无 SessionEventMap 变更），引擎确认后落日志，适配器重启重放；[plan 投影](packages/plan/plan-mode/src/index.ts) 折叠引擎模式记录（`stateVersion` 3→4，缓存从日志重建），现有 plan 指示零改动显示引擎会话模式。
- 子会话目录：可继续的 Team 子会话命令目录只含引擎命令，经 `usingConfigurableAgent → usingChildAgent` 借用对应引擎实例，不调 Host 注册表 RPC；一次性子会话保持空目录。Host 命令（`/model` 等）仍是主会话命令。
- 实现：[模式记录](packages/core/agent/src/engine-records.ts)、[Claude 驱动](packages/subagent/subagent-claude-code/src/engine.ts)与[适配器](packages/subagent/subagent-claude-code/src/main-adapter.ts)、[Codex 驱动](packages/subagent/subagent-codex/src/engine.ts)、[主线协议](packages/subagent/subagent-codex/src/main-wire.ts)与[适配器](packages/subagent/subagent-codex/src/main-adapter.ts)、[plan 投影](packages/plan/plan-mode/src/index.ts)、[命令目录服务](packages/client/ui-commands/src/client/service.ts)。
- 方案与验证记录：[engine-commands.zh.md](docs/scratch/main-agent-engines/engine-commands.zh.md)（已更新为实施状态并附二进制探针证据）。
- 回归：两驱动 [engine-endpoint](packages/subagent/subagent-claude-code/tests/engine-endpoint.spec.ts)/[engine](packages/subagent/subagent-codex/tests/engine-endpoint.spec.ts)（plan 注册、切换记录、重启重放、不支持路径）、[Codex 命令协议](packages/subagent/subagent-codex/tests/main-commands-wire.spec.ts)、[模式记录 round-trip](packages/core/agent/tests/engines.spec.ts)、[plan 投影折叠](packages/plan/plan-mode/tests/plan-mode.spec.ts)、[子会话目录](packages/client/ui-commands/tests/service.client.spec.ts)。
- 待验收：真实供应商 API 下两种引擎 plan 模式的实际生效时机与恢复（本机结论为 keyless 协议探针，不替代实机验证）。

## F28. 桌面端收起侧边栏的悬停预览

macOS／Windows 桌面收起侧栏后不留轨道（`collapsedWidth === 0`），查看工作区、最近会话或全局面板必须真正展开一次，代价是网格轨道改变、中栏重排与整段列过渡。现在指针在窗口左缘条带（自 `--dsh-frame-top-clearance` 之下起）或 `shell.leading` 控件上停留 150ms 即以 `sidebarPeeking` 预览同一列：框架把 `peeking` 与 `SIDEBAR_DEFAULT` 宽度传给既有的 `sidebar` 占用方，AppFrame 给该列行内预览宽度，AppFrame.module.css 以 `position: relative`、层级 17（高于 `shell.leading` 15，低于 `shell.overlay` 20 与右栏全屏 40）让这一个网格项目留在收起后的零宽轨道内、却画得比轨道更宽，以不透明 `--dsw-alias-bg-base` 加 `--dsw-elevation-panel` 悬于中栏之上；绝对定位会让该列退出网格流，中栏被自动放置进那条零宽轨道而整片空白。轨道与宽度偏好都不变，被打 `data-window-drag` 标记的行原地不动，Electron 拖拽区几何因此不重采集；不使用背景模糊，否则本列中固定定位的设置面板会改认它为包含块。移出 200ms 后隐藏；面板内按下过一次后改为「在外部按下才隐藏」，因为列的菜单 portal 到 `document.body`，移出事件无法区分「走向自己的菜单」与「离开该列」。触发要求指针输入模态且顶层没有对话框或菜单（`modalSelector`）。预览期间 `toggleSidebar()` 提交为真实轨道（遵循「收起即忘记拖动宽度」，取 `SIDEBAR_DEFAULT`）；`setSidebar`、宽度变化的 `setViewportWidth` 与 `openRightbar` 清除预览。Web 不预览（保留 56px 轨道）；Windows 只有左缘条带一个入口（重新打开控件留在标题栏行）。

- 实现：[布局 store 与 owner 共享数据](packages/client/ui-layout/src/client/stores.ts)、[AppFrame.tsx](packages/client/ui-layout/src/client/AppFrame.tsx)、[AppFrame.module.css](packages/client/ui-layout/src/client/AppFrame.module.css)、[SidebarRoot.tsx](packages/client/ui-sidebar/src/client/SidebarRoot.tsx)。
- 决策记录：[悬停预览 Agent Note](.agents/notes/implemented/feature/2026-10-09-sidebar-hover-preview.zh.md)。
- 回归：[布局 store 预览动作](packages/client/ui-layout/tests/layout-store.client.spec.ts)、[框架悬停／停留／隐藏／提交](packages/client/ui-layout/tests/app-frame.client.spec.tsx)、[侧栏宽内容与交叉淡出](packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx)。
- 待验收：macOS 真机下红绿灯与 `shell.leading` 控件的几何共存、Windows 顶栏下左缘条带不吞拖拽，均需 `pnpm dsh desktop` 实机确认一次。

## 后续迁移核对步骤

1. 对照本文件的功能项、六个组合包及其配套核心能力，检查目标 worktree、当前仓库、stash 的未跟踪文件和旧 profile 安装清单。
2. 核对每个包的 `package.json`、组合补丁、Host/Client 源码与依赖；构建当前版本，避免混入旧安装包或遗留 `lib`。
3. 核对 Desktop profile 的 `dependencies` 与 `dsh.profile.bundles`；包已安装并不代表组合层已启用。
4. 核对启动脚本、Electron 缓存、主运行时路径、`DSH_HOME` 与 Electron 用户目录；外部脚本和用户目录不随 Git 迁移。
5. 检查插件 ACTIVE 状态、缺失依赖、真实接口及界面行为；逐项记录验证结果，保留未验证项，不能仅凭启动无错误判定功能完成。
6. 修改或迁移 Claude 引擎时，逐项执行本文件的“功能检查列表：Claude 窗口与启动恢复”，记录实际通过项。

- [ ] Agent Team 显式模型选择：主模型先读取 `list_teammate_models`，将用户简称解析成目录完整 ID 后调用 `spawn_teammate`；校验 native/Claude/Codex 兼容引擎、MCP 可见性和目录结果的会话记录。不得用本地模糊匹配替代模型决策，也不得回退到 Lead 模型。

## 其他工具接手的阅读顺序与状态判定

先读根 `AGENTS.md`，改 packages 前读 `docs/architecture.md`，改生命周期时读 `docs/defensive-patterns.md`，改文档时读 `docs/AGENTS.md`。随后按本清单定位代码、包 README 和测试。`docs/scratch/` 是设计与计划，内容可能早于实现；以当前源码、所属 README 和可执行回归为准。本清单的复选框是每次迁移都要重新执行的检查模板，未勾选不表示功能尚未实现。

F1–F23 的迁移基线在 `usable-2026-10-04.1`；该标签之后完善的 F21 模型目录选择、F24 成员计时及 F25–F27 面板收敛、引擎标识与 `/plan` 命令需同时检查工作区差异及后续提交。先运行 `git status --short` 和 `git diff usable-2026-10-04.1`，保留用户未提交改动，不覆盖标签、不清空用户数据、不把已有实现重新归为待开发。

## 定向验证入口

以下命令是后续迭代可执行的入口，不代表它们在每次修改后都已运行。先查对应面板／包源码，再选择相关行；全套覆盖和平台矩阵由 CI 负责。

| 范围 | 检查入口 |
|---|---|
| F1–F7：外部回合、容量、路由与协议 | `pnpm exec vitest run packages/core/agent-loop/tests/external-context.spec.ts packages/subagent/subagent-claude-code/tests/engine-endpoint.spec.ts packages/subagent/subagent-codex/tests/engine-endpoint.spec.ts packages/subagent/subagent-codex/tests/main-catalog-wire.spec.ts` |
| F8–F10、F20、F24：团队入口、成员和任务时间 | `pnpm exec vitest run packages/experimental/client-ui-agent-team/tests/team-action.client.spec.tsx packages/subagent/subagent/tests/timing-projection.spec.ts packages/client/ui-subagent/tests/conversation-ui.client.spec.tsx` |
| F17：固定会话引擎显示 | `pnpm exec vitest run packages/client/ui-model-selection/tests/engine-select.client.spec.tsx` |
| F28：桌面端收起侧栏悬停预览 | `pnpm exec vitest run packages/client/ui-layout packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx` |
| F25–F27：面板收敛、成员引擎标识与 `/plan` 命令 | `pnpm exec vitest run packages/experimental/client-ui-agent-team/tests packages/core/agent/tests/engines.spec.ts packages/plan/plan-mode/tests/plan-mode.spec.ts packages/client/ui-commands/tests/service.client.spec.ts packages/subagent/subagent-claude-code/tests/engine-endpoint.spec.ts packages/subagent/subagent-codex/tests/engine-endpoint.spec.ts packages/subagent/subagent-codex/tests/main-commands-wire.spec.ts` |
| F18：共享 Electron 缓存 | `pnpm exec vitest run apps/desktop/tests/development-electron.spec.ts` |
| F21：模型解释、完整 ID 透传、外部 MCP | `pnpm exec vitest run packages/experimental/tool-agent-team/tests/tool-team.spec.ts packages/subagent/subagent-in-process-driver/tests/team-tool-bridge.spec.ts packages/subagent/subagent-codex/tests/model-catalog.spec.ts` |
| F22–F23：Claude 实际启动环境与恢复 | `pnpm exec vitest run packages/subagent/subagent-claude-code/tests/engine.spec.ts packages/subagent/subagent-claude-code/tests/engine-endpoint.spec.ts packages/subagent/subagent-claude-code/tests/main-runtime.spec.ts` |
| 已录制的 Team 模型可见行为 | `pnpm run test:snapshot -- -t team-targets` |
| 构建、文档及产物使用 | `pnpm run build`、`pnpm run test:docs`；启动用已准备的 `dsh-start`，标准 `start:desktop` 的目录区别见 F19 |

真实 Claude fixture 和 MCP 测试需本机回环端口；若沙箱报 `listen EPERM`，按 AGENTS 的宿主重试规则执行同一命令。需要实际供应商 API 的验收单独记录，不将 keyless fixture 结果描述为真实供应商兼容性验证。pnpm 若报告依赖需重新安装，先核对本机 pnpm 版本和 workspace 状态，不能把安装失败计作测试失败。

## 必须保留的行为与迁移检查

- [ ] F1–F7：引擎选择在首条消息后锁定；模型目录按端点可达性过滤；审批和用户提问走所属服务；原生工具只读展示；不自动重放投递状态不明的输入。
- [ ] 启动次序：DSH inbox 可先接收消息，但原生用户 prompt 必须等 `prepareExecution` 完成；Claude 等初始化应答，Codex 等初始化和 thread 创建／恢复。不要把队列接收、协议初始化或 `running` 状态误当作原生消息已投递。
- [ ] F8–F10、F20、F25：Team 单一入口保留成员、任务看板与引擎子项；Harness 子会话目录只出现在普通会话的独立入口；任务归属和成员活动分别解释，不以进程退出冒充任务完成。
- [ ] F24–F25：`subagentTiming` 投影仍按多轮规则折叠（新轮次隐藏旧结束、保留首次开始）；面板中成员与引擎子项不显示时间行，开始／结束与耗时只在任务卡。
- [ ] F11–F12：共用 home 补丁跨 profile 生效；权限策略不会向不支持 steering 的外部引擎发送 steer。
- [ ] F13–F14：macOS unsigned 路径保留；调度失败仍写明确工具结果；多副本 runtime 使用同一 scheduler key。
- [ ] 六个组合包分别核对安装、启用、依赖、接口及界面行为；ACTIVE 不能代替完整验收。
- [ ] F17–F19：锁定引擎显示静态名称；Electron 复用共享缓存；配置和 userdata 共用指定 home。移除 e2a7 前替换外部启动脚本的旧资源路径。

- [ ] Team 任务规划：三个计划任务须提前进入共享任务板，后两个通过 `blocked_by` 等待首项；派发传入 `task_id` 不新增重复任务，阻塞或已领取任务不能派发；人工 review 通过前不启动后续成员。

## 尚未完成和未验证事项

| 项目 | 当前范围与下一步 |
|---|---|
| 思考程度映射 | 现有引擎映射已存在；精确模型语义、Kimi／GLM／DeepSeek 接口验证及映射编辑界面仍待完善，见 `docs/scratch/main-agent-engines/implementation-plan.zh.md` |
| Codex 命令 | 已有 `/compact`、`/review`、技能发现与 `/plan` 协作模式（见 F27）；真实供应商 API 的模式生效时机与恢复实机验收待完善，不能把旧 TODO 解释为全部未实现 |
| Dashboard 增强 | 客户端 owner ID、未读徽章、搜索、折叠待完善；独立 store 是可选架构改进 |
| 个人项目看板／保活 | 看板用量对账与归档总结真机验收仍待完成；保活状态见插件清单。旧助理工作台及中间终端已移除 |
| 可移植启动 | `dsh-start`、Electron 缓存和 DSH home 不属于 Git；旧 worktree 主运行时路径仍需替换 |

### Team 初始任务与外部引擎模型显示（2026-10-04）

Lead 先通过 `team_task_create` 建立全部已知计划任务及 `blocked_by`，包括尚不能执行的任务；普通 TODO 不替代 Team 任务板。`spawn_teammate(task_id)` 复用未领取、待执行且依赖已完成的任务，省略时自动创建初始任务；初始提示携带任务 ID，要求成员读取、领取并完成任务。界面展示所有未删除任务，依赖未完成的显示等待依赖及依赖 ID；依赖完成只改变就绪状态，不自动派发。用户要求 review 时，Lead 必须等待明确确认后才派发，不新增持久审批状态。Claude/Codex 引擎准备时记录解析出的模型选择，客户端模型投影使用该选择，避免因没有原生 request/header 而显示目录默认模型。历史未建任务不会凭空补成已完成任务。

本次任务规划改动已通过工具包 34 项测试、补充的不存在／已领取任务拒绝测试、`team-targets` keyless 会话快照、Host 类型检查、定向 Lint 和 README 双语配对检查；Host 运行包、Web 前端与 Desktop 已构建。现有会话的普通 TODO 不自动转成共享任务；需由 Lead 显式补建。构建后尚未重启应用进行真实模型验收。

### Team 面板折叠与任务流程图（已实现，待真机验收）

用途：控制成员、任务长列表的高度，通过流程执行图展示执行顺序和当前状态。布局顺序为顶部任务流程图、成员列表、任务列表；成员使用随宽度自动换行的紧凑卡片并列排布。方案包括独立区域／分组折叠、计数摘要、任务依赖节点、节点定位任务卡、实时更新和键盘访问；复用现有任务投影，不新增审批状态。设计见[Team 面板折叠与任务流程图](docs/scratch/main-agent-engines/team-panel-flow.zh.md)。

实现位于 client-ui-agent-team：`TeamSection` 提供共享可折叠区域（`aria-expanded`/`aria-controls`、折叠时焦点返还标题）；`TaskGroups` 按执行中／待执行／已完成分组折叠，等待依赖计入待执行，已完成默认折叠，长列表在有界滚动区域内滚动；`TaskDependencyGraph` 渲染只读流程执行图，按依赖分层，前置箭头按已完成／未完成区分实线与虚线，缺失前置显示只读占位节点，循环依赖显示提示，提供适应画布、放大、缩小、全屏与拖拽平移，节点点击或键盘选择展开任务区域及所在分组、滚动并高亮对应任务卡；任务说明默认单行截断、可展开全文，负责人名称在名册唯一解析到 active 且非当前会话的成员时可点击打开该成员会话查看执行输出，未领取或无法解析的任务保持纯文本；`task-flow` 提供纯函数分组、状态映射与分层布局，`fold-state` 与 `collapse-preferences` 把折叠偏好按 Team 根会话、区域和分组存入浏览器存储键 `dsh.agent-team-panel.v1`，不写入 Session 日志。头部面板保留成员与任务折叠及打开 Dashboard 的入口，不嵌入画布。状态与负责人更新只改写节点内容并保留视角，仅任务集合或依赖变化才重新布局。

实现已通过包内 73 项客户端测试（折叠计数与偏好保持、节点定位隐藏任务卡、依赖图状态映射与异常投影、指针拖拽与键盘访问），新建客户端源码文件在本包测试范围内 100% 覆盖；client 面 tsc、定向 oxlint、doc-sync 与 README 双语配对通过；Host 与 Client 完整构建（含 Web dist 与 Desktop bundle）成功。窄侧栏手动操作、大任务集合性能与真机多端验收尚未执行；折叠偏好不做跨浏览器同步。

### Agent Team 工作流创建与即时调度（已并入程序化调度）

`team_workflow_create`、`dispatch_task`、等待结果、强制中断和 `currentTaskId` 构成当前工作流接口。原先按阶段顺序创建及通过 Lead 侧 `reassign` 领取的实现已由统一持久调度取代；当前原子计划、审批、恢复、执行许可和路径校验以[程序化调度与受控消息](#agent-team-程序化调度与受控消息阶段一至三已实现待真机验收)条目及其[设计文档](docs/scratch/main-agent-engines/agent-team-controlled-scheduling.zh.md)为准。

### 模型侧 session_create 会话创建工具（已删除，构建通过）

2026-10-05：按用户要求删除实现、测试、组合包注册、依赖及工具目录引用；Web、Desktop 不再提供模型侧跨工作区创建会话能力。已有会话保留，普通界面创建会话功能保留。此次删除不表示已确认该工具导致 Electron 子进程被终止。 `pnpm run build`（含 Web）和 `pnpm run build:desktop` 通过；工具、配置目录新鲜度和移除说明双语配对通过，构建产物未发现插件注册残留。Claude/Codex `/startup` 源码映射已补齐，`verify-cordis-config` 全部 217 个配置文件通过。

### 个人插件用量看板与归档选择（原引擎总结已实现，待真实引擎验收）

个人插件已改为每日、每周项目与会话用量看板，旧任务、Todo、知识和助理对话功能已废弃；下方个人助理条目记录此前实现，不代表当前功能。看板中文万、亿单位保留两位小数。归档确认框默认不总结，用户勾选后才请求追加摘要到项目 `CHANGELOG.md`；原会话的已选引擎收到含 changelog 绝对路径的简短总结请求，并直接使用自身工具追加带时间的条目；总结轮次结束后，Host 在 Agent 维护阶段内只读检查条目并提交归档，期间暂缓新轮次启动；请求、工具操作、回复与 token 用量记录在原会话日志。失败时不归档，引擎已执行的文件改动仍保留。真实页面的启动、归档选项与普通归档行为已通过录制会话回放验证。详细状态见[功能清单](docs/features.zh.md)。

### 个人助理任务主页、固定目录与全局会话（已废弃，保留历史记录）

用途：让任务管理成为固定栏目，减少长对话占用；中间默认显示常驻对话，任务与个人知识作为并列 Tab，任务 Tab 内任务与 Todo 左右分栏合列。同一 DSH_HOME 和助理存储复用一个固定 Native 协调会话，工作目录固定为助理专属 workspace（可配置）；Host 统一创建与恢复，任务执行使用独立项目会话。目录更换保留旧日志并以 `working-directory-moved` 原因记录迁移，客户端在中间对话 Tab 提供更换提示与旧对话入口；另一存活 Host 以不同目录确认同一存储时报配置冲突，不再反复替换。设计见[个人助理任务主页与固定会话](docs/scratch/main-agent-engines/personal-assistant-workspace.zh.md)。

实现状态：任务存储已从 `tasks.v1.json` 迁到 `personal_assistant` 存储 domain（组合包路由到 SQLite `$DSH_HOME/storages/personal-assistant.db`，其余 domain 保持基座 json 默认），旧 JSON 文件不再读写、记录不迁移；Host 侧 `assistantWorkingDirectory` 配置（默认 `<dataDirectory>/workspace`，显式配置必须为绝对路径）、固定 cwd 的协调会话创建／采用／迁移／冲突决策（`planCoordinatorAction`）、`coordinatorDirectory` 身份存于 domain 单例，并移除 `dashboardReplaceCoordinatorSession` 操作；客户端已移除"目录中找不到便创建"路径，任务 Tab 承载最大 1200px 的分组任务看板（需要处理／待验收／进行中／待办／已结束，按紧迫度排序、组可折叠、搜索与项目筛选、任务单行展示状态与时间、悬停显示会话操作、宽屏概览双列），并列的中间对话 Tab 承载常驻对话且默认激活，另有"针对该任务提问"草稿引用、可见期轮询与旧对话查看入口。插件 13 项 Host 生命周期测试（真实 domain 设施 + 内存 kv 后端）通过，双端 bundle 构建通过，README 双语同步；尚未重启真实 profile 做多端与迁移验收。升级指南见 `docs/upgrade-guide/v0.2.0-rc.2/assistant-working-directory/`。

### 个人助理中栏工作台、父子任务与历史分页（已废弃，保留历史记录）

用途：将中栏助理工作台组织为概览、全部任务和历史三个视图；父任务汇总多个子任务，详情展示依赖、状态、真实起止时间、成果和各次执行。完整任务与历史支持全量范围的搜索筛选、服务端分页和返回位置恢复，概览突出需要处理、正在执行、接下来与最近成果。

实现状态：两级任务、同父任务依赖（前置验收后解锁）、父任务整体验收与重开、原子 `createPlan`（含叶任务转容器）、`expectedRevision`／`requestId` 幂等写入、父任务取消的停止-确认流程、执行意图登记（启动崩溃进入需要处理，不出第二个 Session）、成果引用（Host 校验的执行会话）与失主进程扫描均已实现；存储升级为版本命名后继 domain `personal_assistant_v2`（tasks／executions／results／activities 四表 + 协调会话单例），v1 记录一次性复制迁移、原位保留、失败重试。跨记录事务由 storage 包新增的 `KvUnit.applyBatch`（SQLite BEGIN/COMMIT、json 单文件发布）与 `Domain.transact` 承担，存储包测试全绿且新代码 100% 覆盖。查询侧实现服务端分页、查询快照（`queryId`／`changedSinceQuery`／`query-expired`／`query-too-broad`）、关键词搜索（父子标题描述 + ID 精确匹配、子任务命中摘要 ≤3）与配置化配额（defaultPageSize/maxPageSize/overviewGroupLimit/querySnapshotTtlMs/maxQuerySnapshotsPerIdentity/maxQueryResultIds/maxSummaryCharacters/searchDebounceMs）。客户端把任务与 Todo 合并为一个任务列表（2026-10-08 改版：去掉"任务"标题与概览／全部任务／历史三视图，左栏为按状态分组的未完成任务和带关键词搜索、服务端分页的已完成列表，右栏为未完成 Todo，卡片固定一行一条；顶部"＋ 新建"菜单建任务或记 Todo）、任务详情（概况／需要处理／子任务展开／成果／执行历史）与取消确认、刷新提示、查询过期恢复；展示偏好按工作目录哈希本地保存。插件 28 项 Host 生命周期测试通过，插件 bundle 构建通过，README 与升级指南双语同步（`docs/upgrade-guide/v0.2.0-rc.2/assistant-task-center/`）。Web 真机验收已做（2026-10-06，改版前布局）：概览／全部任务／历史三视图、父子计划创建、依赖与缺项目标注、详情分节与未知时间标记、取消入历史、查询快照分页均在真实 profile 验证通过；期间修复两处客户端缺陷（残留 `scrollRef` 引用导致右侧面板挂载崩溃、任务路由把 `op` 键透传给严格 schema 的 op 参数）。限制：成果会话引用只读展示、未接入共享会话导航；设计§15 的性能基线（万级任务规模、p95 目标）未测量；Desktop 真机验收待做。设计见[个人助理右侧工作台与分层任务详细设计](docs/scratch/main-agent-engines/personal-assistant-task-center.zh.md)。

### 个人助理接口加载修复（2026-10-05，旧接口已移除）

已确认运行中的 Web profile 未安装助理，配置和任务接口均返回 404；Desktop 与 Web 的插件安装列表独立。修复补齐助理包的 SQLite 后端依赖、API 根路径和明确的 profile 加载错误说明，并在本机 Web profile 安装助理及本地 SQLite 后端。插件已重建，13 项运行时测试通过；配置 GET 路由补齐必需的 requestBody=buffered，避免未指定时按流式请求处理而返回 400。完整构建 `pnpm run build` 与 `pnpm run build:desktop` 已通过，本地助理／终端／最近会话插件已重建，保活使用源码入口。Web 与 Desktop 的本地插件安装已对齐，Desktop 补齐 SQLite 依赖并刷新开发包链接；实际 Web profile 及 `dsh-start` Desktop 启动后配置与任务接口均返回 200。验证实例已关闭，具体任务执行与多端写入仍须单独验收。

### Agent Team 程序化调度与受控消息（阶段一至三已实现，待真机验收）

用途：在现有任务图、ready／claim 和 mailbox 能力上统一启动校验、原子领取、程序调度、消息投递及执行许可，防止模型提前启动、重复执行或通过消息绕过依赖。普通消息与任务分配、停止控制分开；等待任务保存消息但不唤醒进程。设计明确外部引擎工具授权必须覆盖实际执行路径，不能只靠提示词或 MCP 校验。

状态：阶段一至三已实现。统一启动入口 `dispatchTask`（服务层与 `dispatch_task` 工具）在最新状态下原子领取并幂等重放；完整 DAG 通过单个持久事件原子写入；结构化拒绝包含依赖、所有者、状态与目标。显式分配的待办任务会在成员可用、依赖完成及审批通过后自动调度；事件触发与可配置周期兜底扫描共同发现就绪任务。`team_task_approve` 先向用户请求一次性决定并持久保存；恢复时无活动 owner 的执行标为 `startup-unconfirmed`，禁止自动重复启动，Lead 可显式释放并在新代次重新领取。任务代次绑定引擎执行许可，任务结束、转移或成员回合结束后撤销；Claude／Codex 回调与原生 Harness 工具均校验许可，写入范围外拒绝，其他原生工作工具要求逐次用户批准。执行派发前校验声明输入路径，完成前校验成果存在、位于工作区且在声明写入范围内。限制：无并发配额或失败自动重试；崩溃后无法确认的任务需人工核对后释放；路径存在性不能替代业务验收，获批命令的副作用不能被完整限制。见[程序化调度、执行校验与消息协作设计](docs/scratch/main-agent-engines/agent-team-controlled-scheduling.zh.md)与[升级指南](docs/upgrade-guide/v0.2.0-rc.2/team-controlled-dispatch/guide.md)。

### 个人助理中间对话、任务与个人知识标签页（已废弃，保留历史记录）

用途：以中间对话为默认主界面，并列提供任务与个人知识 Tab；Todo 作为任务 Tab 内的子列表，保留任务概览、完整任务、历史、筛选和分页。

状态：三个 Tab 的内容切换时保持挂载，保留草稿、筛选及滚动位置；任务“进入会话”和任务／知识引用提问自动切到中间对话，执行会话提供返回常驻助理入口。使用共享嵌入式 `conversation.content` 与 `SessionProvider`，不再将助理对话注册为右侧栏标签页。插件 Host/Client 构建通过，36 项测试通过（含新增客户端布局测试：默认对话、Todo 子列表、草稿保留、任务／提问导航与键盘切换）；README 双语已同步。Web/Desktop 实际运行与主题验收待做。

### 个人助理任务闭环、Todo 与知识（已废弃，保留历史记录）

用途：按[个人助理任务、Todo 与长期知识设计](docs/scratch/main-agent-engines/personal-assistant-tasks-todos-knowledge.zh.md)补齐任务闭环与两个新工作台入口。任务携带引擎/厂商/模型执行配置（任务 → 父任务 → 插件默认逐级回落，`defaultEngineId`／`defaultProvider`＋`defaultModel` 可配），每次执行写入实际配置快照；启动链为解析配置 → 按引擎创建 Session → `selectModel` 校验并安装模型 → `prompt` 提交首条任务消息，任一步失败进入需要处理并保留原因。任务进入等待验收的唯一通道是执行模型经受限工具 `task_execution` 提交成果（deliver）；未提交成果的回合结束进入需要处理。`task_execution` 对 Native 走框架工具注册，对 Claude/Codex 经 `dsh-subagent-in-process-driver` 的会话级 MCP 桥（桥在会话作用域携带该工具时启动，Team 行为不变）。任务卡与详情提供"进入会话"（中间对话 Tab 切换执行会话，任务 Tab 保持视图/滚动/草稿），成果引用可打开其执行会话。对话内验收经 user-questions 用户确认后由 Host 以用户身份执行。Todo 使用独立 `todos` 表，在任务 Tab 右栏列出未完成项，`convertTodo` 同事务完成转换并按 `requestId` 幂等重试，任务取消后的恢复需用户显式操作。个人知识以 `$DSH_HOME/personal-assistant/knowledge`（`ideas/`、`notes/`，修订备份 `revisions/<id>/`）下的 Markdown 文件为权威正文，domain 只存可重建索引；原子写入、内容哈希冲突检测（`knowledge-conflict`）、stat 识别外部编辑、显式导入/repair 补齐元数据、标题/标签/正文检索。存储 domain 保持版本 2 的增量演进（新增字段全部可选、新增表初始为空），旧数据照常打开。

状态：插件 34 项 Host 生命周期测试通过（新增执行配置与启动链、交付制评审、对话验收、目录、Todo 转换、知识生命周期覆盖）；`team-tool-bridge` 5 项测试通过（新增执行通道暴露与仅执行作用域启动）。README 双语与升级指南（`docs/upgrade-guide/v0.2.0-rc.2/assistant-task-loop/`）已同步。待办：真实 profile 重启后的多端验收（三引擎执行会话、MCP 桥工具可见性、会话导航与返回恢复、知识目录真机读写）；搜索/万级任务与大量 Markdown 文件的性能未测量；客户端组件级自动化测试未新增（沿用 Host 侧行为覆盖）。
