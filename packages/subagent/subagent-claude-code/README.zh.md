---
description: "面向用户与维护者的一次性 Claude Code subagent 提供方，用于选择产品后端、安装 Profile bundle 或配置无人值守的 Claude Code 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-claude-code

[English](README.md) | 中文

`/startup` Cordis 入口注入 `agents`、`llm`、`credentials` 和 `subprocess`，注册 Claude Code 主对话引擎。部署字段包括 `provider`、`model`、`env`、`pathToClaudeCodeExecutable` 和 `disposeGraceMs`。主引擎入口不注册子代理厂商。

## 概述

当委派任务应在父工作区中以全新、无人值守的 Claude Code 会话运行时，安装这个 Profile Bundle。每次运行接受一个自包含文本任务，并返回最终答案或安全的失败诊断；推理、工具通信、stderr、用量信息和工作区差异不会进入父 Session。Claude 原生设置与身份验证继续是权威来源，而 Profile 配置选择模型、环境和 `permissionMode`。针对平台锁定的运行时仅在需要时启动，并且绝不会回退到宿主 `claude` 可执行文件。当隔离和真实 Claude Code 行为比续接或提示更重要时，选择本包。

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

当委派应以父级工作区中的真实 Claude Code 会话运行时，挂载本提供方。常用路径是显式的：把 Bundle 安装进 Profile，可选地配置提供方行，并通过委派工具行把它暴露给模型。

### 安装 Bundle

把包安装进目标 Profile，然后重启该 Profile。安装会把锁定的 Agent SDK 与一个兼容的平台 CLI 载荷带入 Profile；声明的 patch 层只注册休眠的提供方，不启动任何 Claude 进程。

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
dsh --profile <name>
```

移除包后，下一次 Profile 启动会撤回提供方及其私有运行时闭包。安装决定 Host 可用性，而不是模型权限：模型只能通过你组合的委派工具行触达提供方。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `claude-code` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `model` | Claude 原生设置 | 为本提供方实例的每次运行固定的可选非空模型名称；省略时不发送 SDK 覆盖 |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式 SDK/CLI 环境 |
| `permissionMode` | Claude 原生设置 | 为本提供方实例的每次运行固定的显式原生非交互权限模式；省略时由原生设置解析模式 |
| `disposeGraceMs` | `3000` | 共享 managed-range owner 各终止层级之间的宽限 |

| `permissionMode` 值 | 原生行为 |
|---|---|
| 省略 | 由原生设置解析模式（`defaultMode` 与规则列表） |
| `dontAsk` | 不弹出提示，直接拒绝尚未获授权的操作 |
| `acceptEdits` | 接受文件编辑；其余权限提示由无人值守回调拒绝 |
| `auto` | 由 Claude Code 原生分类器允许或拒绝权限请求 |
| `plan` | 使用原生规划模式，拒绝执行审批，并把完整计划作为最终答案返回 |
| `bypassPermissions` | 显式设置 SDK 的危险确认并跳过权限检查 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)是每个受支持字段及其 JSDoc 的穷尽式真源。已配置的 `model` 会原样传给该提供方实例的每次 query；省略时保留原生模型选择。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的 API 密钥必须在该配置中显式提供。提供方省略 SDK 的 `settingSources` 选项，因此 Claude Code 会相对于父会话 cwd 读取宿主机常规的用户、项目与本地设置。它不会复制或过滤这些文件、创建或修改登录状态、检查 `PATH`，也不会回退到宿主 `claude` 可执行文件。

### 主引擎端点解析

导出的主引擎工厂读取会话选择的厂商；没有选择时使用部署的厂商覆盖值。两者均缺失时，必须恰好有一个路由声明 `anthropic-api`；路由缺失或存在歧义会在启动前失败。工厂经凭证服务解析路由的凭证引用，并优先使用会话选择的模型，其次使用部署默认值。Claude 接收 `ANTHROPIC_BASE_URL`，配置密钥时还接收 `ANTHROPIC_AUTH_TOKEN`。 显式引擎环境配置覆盖注入值。Bundle 的 `apply()` 继续挂载一次性子代理 provider；使用主引擎工厂需要单独注册引擎。

### 暴露工具

每个委派工具行指名一个提供方，并需要独立的 `toolName`，因此模型看到的是静态工具，而不是动态提供方选择器。完整 Agent Preset 携带对应的默认工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent（智能体）暴露 `subagent_claude_code`。

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-claude
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`one-shot` 策略会让省略 `run_in_background` 或传入 `false` 的调用继续在前台等待，而显式传入 `true` 会返回由父 agent 拥有的 job id，供 `job_output` 或 `job_kill` 使用；base host（基础宿主）与完整 preset 已提供通用作业注册表和控制工具。

### 你会得到什么

前台调用会把严格的最终 Claude Code 答案交给模型；运行失败时则返回带停止原因与可选安全诊断的错误。后台调用先返回 job id；随后通用作业控制面会送达完成通知，并通过 `job_output` 公开同一最终答案或失败状态。Claude Code 的推理、工具活动、中间消息、stderr 与工作区差异绝不会进入父级会话。

### 失败与恢复

省略 optional dependencies、当前平台不受支持或所选载荷缺失的安装会让提供方保持休眠，并在第一次委派时于 SDK 启动边界报告安全的 `query-start` / `unknown` 失败事实；不存在宿主 CLI 回退。原始产品错误只保留在内部 cause 链与提供方 Host 日志中。被取消的运行以 `aborted` 结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方如何驱动真实 Claude Code CLI，以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **每次运行一个全新 query。** 每次运行都拥有独立的 SDK query、取消控制器、CLI 进程与不持久化的产品会话；没有续接、恢复或池化。
- **原生设置是权威。** 提供方故意省略 SDK 的 `settingSources` 选项，因此 Claude Code 读取宿主机常规的用户、项目与本地设置；可选 `model` 与必需的 `permissionMode` 是仅有的 query 级覆盖。
- **刻意无人值守。** `AskUserQuestion` 被禁用，除 bypass 模式外权限提示都会被拒绝，因此 query 绝不会等待用户界面。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | SDK query 生命周期、结果接受与权限处理 |
| [`src/process.ts`](src/process.ts) | dispose（资源释放）时的 managed-range 逐级终止 |
| [`tsdown.config.ts`](tsdown.config.ts) | 分别打包提供方与主引擎入口；发布文件不依赖共享 chunk。 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册休眠提供方的 Profile patch 层 |

### 运行流程

一次启动只接受非空的文本块序列，并根据父会话确定子级 cwd。它创建私有 `AbortController`，用精确拼接的任务调用官方 SDK `query()`，并仅在 SDK 的 custom-spawn 钩子已经提供由子进程 seam 管理的活动 CLI 句柄后发布运行。提供方完整迭代消息流，只接受满足 `subtype: "success"`、`is_error: false` 且 `result` 非空白、随后迭代器正常结束的 `result` 消息。其余一切结果都映射为带固定类别的 `error` 诊断，命名生命周期阶段与已观测进程结果——类别集合见 [`src/run.ts`](src/run.ts)。本地取消会在结果竞态中胜出并映射为 `aborted`，且不附带失败诊断。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方逐步进入它接入的 seam 与兄弟产品提供方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Codex subagent 提供方](../subagent-codex/README.zh.md)——经官方 app-server 协议的兄弟产品后端。
- [Claude Code 与 Codex 后端](../../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)——产品提供方的设计记录。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)——每个受支持配置字段及其源声明。

-----

## 主对话执行

主对话输入框会列出当前 Claude SDK 会话报告的命令。提示词命令作为普通且持久化的 Session 消息提交，由 CLI 在自身对话中执行；Session 切换引擎或模型时会刷新命令目录。SDK `commands_changed` 消息也会使客户端目录缓存失效。图片附件从已授权的附件存储读取，并以 Anthropic image block 发送。已省略图片使用纯文本附件提示；此引擎暂不支持通用文件附件。

`./startup` 提供者独立于单次委派注册主对话驱动。每轮前读取会话提供者、模型、推理等级及 `anthropic-api` 端点。Harness API Key 通过 `ANTHROPIC_API_KEY` 传递，端点通过 `ANTHROPIC_BASE_URL` 传递；原生配置目录为 `$DSH_HOME/engines/claude`。厂商、端点、密钥、模型或推理等级改变时，下轮执行先关闭旧 CLI 并等待退出，再以新参数启动进程。已有输入投递记录的持久化原生会话标识通过恢复继续，不会重放 DSH 历史。尚无输入投递时查询命令会启动新的原生会话：仅 SDK 初始化不会创建可恢复的历史。已结算的轮次会报告 token 用量及当前模型的原生上下文窗口，由共享 loop 记录，供输入框下方的统计与上下文用量表使用。会话权限预设是唯一权限来源：完全权限（danger-full-access 沙箱且审批为 never）直接翻译为原生 `bypassPermissions` 模式，工作区修改选择原生 `acceptEdits` 模式，其它预设保持原生默认提示行为。引擎不读取宿主机 `~/.claude/settings.json`，宿主权限规则无法限制或重新定义会话。CLI 像在原生运行中一样加载全部三个设置层级，引擎同时把宿主机 `~/.claude/CLAUDE.md` 镜像进自己的配置目录，让用户级指令生效，而设置字段、凭据与会话保持隔离；`project` 与 `local` 层级也会像原生 CLI 一样激活仓库的设置、skills 与 hooks。宿主若没有 `~/.claude/CLAUDE.md`，则不会镜像任何指令，会话保持原生默认行为。

会话权限预设选择原生权限模式——完全权限且 Never 变为原生 bypass，工作区修改变为原生 edit acceptance，其它预设保持原生默认——预设仍控制原生沙箱、只读工具白名单与审批路由。原生权限提示通过 `canUseTool` 路由到会话审批服务，而所选原生模式允许的操作不带 DSH 审批记录执行。受限预设要求启用原生沙箱。Workspace-write 与 Ask 的组合仅允许经过原生权限审核的无沙箱重试；其他受限策略禁止此类重试。只读仅提供 Read、Glob、Grep 及 AskUserQuestion。授权和提问回复随所属轮次结束而失效。

主对话在配置 `pathToClaudeCodeExecutable` 时通过 subprocess 提供者解析路径；显式值无效时会在接收消息前失败。未配置时先从 PATH 查找 `claude`，再查找 `~/.npm-global/bin/claude`，两者均不存在时使用 SDK 自带版本。准备新 CLI 进程时执行解析，已有进程保留当前可执行文件。所选宿主 CLI 必须支持固定版本 SDK 的协议。单次委派仍使用其固定版本运行时。

主对话根据提供方模型元数据，将完整上下文容量传入 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，并将该容量的 90% 传入 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。模型名原样传递。元数据未提供容量时，两个变量均省略，包括部署配置和继承环境中的值。这两个设置告知 Claude Code 网关模型的容量和压缩阈值，不会扩大提供方模型的容量。`env.CLAUDE_CODE_EFFORT_LEVEL` 保留为显式部署设置，不会自动设置。

MCP elicitation 使用同一所属轮次的提问服务：基本类型表单支持字符串、数值、整数、布尔值及枚举字符串数组；答复按请求的 JSON Schema 校验。HTTP(S) URL 请求展示链接并等待明确确认，不自动打开浏览器，也不宣称认证成功。密码、只写、嵌套及不支持的 schema 会被拒绝。通用 SDK 对话框保持关闭，因为当前集成没有对应类型的专用渲染器。

原生工具输入及进度更新显示在观察卡片中。`activityUpdateIntervalMs` 默认将每个工具的进度记录间隔限制为 100 毫秒；工具终态仍立即记录，`maxActivityCharacters` 限制流式参数长度。空闲 CLI 退出后，下次准备会恢复同一持久化原生标识。已派发但未到达终端原生结算的轮次会结算为 `acknowledged-uncertain`——失败回合被观察到时立即记录，写入进程崩溃后由下次准备补记；输入不会重发。观察流失败会终止所属受管 CLI 并等待退出。嵌套代理的对话帧不会混入主对话回答；带显式输入 UUID 的原生结果必须匹配已接受的轮次。原生结果错误在凭证脱敏后保留诊断文本。

主引擎的 `providers` 字典将已注册的 LLM 路由映射到 `opusModel`、`sonnetModel`、`haikuModel` 和 `subagentModel`，分别填入 `ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL` 和 `CLAUDE_CODE_SUBAGENT_MODEL`。未设置的字段依次使用显式部署环境变量、会话选定模型，避免宿主环境别名将内部任务路由到无关模型。映射变化会在下一轮前替换 CLI。主模型仍使用配置目录中的确切模型名，包括 `[1m]`；别名不会向 Harness 模型目录添加模型。

## 原生子代理状态

主引擎在检查前台轮次归属前消费 `task_started`、`task_progress`、`task_updated` 和 `task_notification`。`Agent` 及旧版 `Task` 调用建立子代理身份；带 `parent_tool_use_id` 的消息更新子代理输出，不进入父会话正文。非代理及后台维护任务被排除。原生完成、失败或停止事件更新对应记录，SDK 流断开时将未结束的子代理标为未知。`maxActivityCharacters` 限制子代理文本长度。观察接入不提供直接向子会话发送消息或单独中止的能力；缺少生命周期通知的旧版 SDK 流可能无法确认子代理终态。

前台 Agent/Task 工具结果会结算子代理状态；结构化后台启动结果仍保持运行中。父会话两轮之间收到后台完成通知时，排队写入一条以原生工具调用为来源的持久化完成消息，并在同一个原生会话上唤醒父模型。运行中的父轮次由引擎自行处理完成通知；停止或替换进程不会伪造完成。

主引擎的 `providers[provider].reasoningEfforts` 将可选标识映射为 SDK 值（`low`、`medium`、`high`、`xhigh`、`max`），或用 null 表示 `thinking: {type: "disabled"}`。`defaultReasoningEffort` 指定可选默认标识，`models[exactModelId]` 可覆盖任一字段。没有覆盖时继承适配器中兼容的协议映射及默认值；SDK 不支持的值不会出现在菜单中，明确选择时会拒绝。映射后的程度及思考模式参与进程替换和原生恢复。参见[配置示例](../../../docs/main-agent-engines.zh.md#engine-reasoning-mapping)。

`./startup` 入口在子代理服务可用时还会注册 `engine:claude`。该基于 Session 的 provider 通过主对话 Claude 驱动支持持续子代理：持久历史、活动卡、原生身份、人机交互、中止和后续轮次。包根的一次性 provider 保留独立的无人交互配置和行为。子代理厂商、模型、思考程度来自委派 Agent 参数及已配置的厂商 endpoint。

启用 user 配置来源时，主会话通过目录链接将 `~/.claude/skills` 和 `$DSH_HOME/skills` 合并到 `$DSH_HOME/engines/claude/skills`；同名文件夹优先采用原生全局目录。启用 project 配置来源时，项目 `.claude/skills` 继续由引擎按工作目录发现。已有真实文件夹和无关链接保留，准备引擎时移除失效的受管链接。源文件修改直接可见，不复制技能正文。

Claude 的本地命令输出与提示消息持久化为原生活动卡。`/plan` 在活动查询上切换原生 plan 权限模式：进入时把 SDK 权限模式切到 `plan`，`off` 恢复会话策略解析的模式（策略选择原生默认时为 `default`），每次获引擎确认的切换都会记录到会话日志，重启的适配器会重新应用。压缩状态及 `compact_boundary` 更新同一个操作，并保留原生 token 元数据与失败详情。没有助手文本的成功结果只展示一次原生结果；未执行压缩时显示原生原因，不宣称压缩完成。模型与权限继续由 Harness 控件管理。原生 `clear`、`reset`、`resume`、`rewind`、`fork`、`exit`、`quit` 命令在支持会话重新绑定前隐藏并拒绝执行。

拥有作用域内 Harness Team 工具的主对话通过 SDK `mcpServers` 连接进程专属的 `dsh_team` HTTP MCP 服务。这些工具在原生权限层显式允许，但仍经过 Harness 工具策略及 Team 授权。`teamToolTimeoutMs` 配置原生 MCP 截止时间，默认 3,660,000 毫秒。驱动在冷恢复或进程重启时重建连接，并在 turn 结束时等待未完成调用结束。

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

Claude Code 子级会在一个全新的 SDK query 中接收独立文本任务。它的工作区是父会话 cwd；所选提供方实例会固定已配置的模型、环境与非交互权限模式，而省略的模型及其余产品设置来自 Claude 原生配置。可执行版本来自 Bundle 锁定的 SDK 平台载荷。

#### Token 影响

子级需为独立的 Claude Code 上下文和 query 承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 Claude Code 自身的模型、指令、工具、原生设置和全新 query。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，前台调用会让父级模型看到符合严格成功条件的 Claude Code 最终答案；若结果未完成，错误中会包含终止原因和可选的安全诊断。该诊断可以区分粗粒度行动类别、生命周期阶段和已观测的进程结果，而不复制原始产品文本或版本专属 subtype 名称。后台调用会先返回 job id；随后通用作业控制面会送达完成通知，通过 `job_output` 公开同一最终答案或失败状态详情，并允许 `job_kill` 请求取消。Claude Code 的推理、工具活动、中间消息、stderr、工作区差异、用量信息、产品标识符、工具输入和原始协议载荷均不会复制到父会话。

#### Token 影响

前台输入会增加工具结果中保留的最终答案或错误内容。后台输入还会包含启动确认、完成通知，以及 `job_output`、`job_kill` 或后续状态结果；子任务 token 仍不会进入父级上下文。本提供方自身不添加父级工具 schema。

#### KV Cache 影响

仅追加：前台会在可复用的父请求前缀后增加一个结果，后台则会继续追加 Job 启动确认、通知以及后续控制或收集结果。后台调度可能增加一个由通知唤醒的轮次，但这些消息都不会改写更早的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 Claude Code 对比或任务积压。

- **每次运行均新建一个 query 和一个进程**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改提供方与模型，而且每个公开工具都需要唯一的 `toolName`。
- **宿主设置有意保持权威**——省略 `model` 时由项目与用户设置选择模型；原生设置始终保留其余工具和行为，本提供方不提供经过筛选或与宿主环境隔离的生产模式。
- **身份验证与账户状态仍由原生机制管理**——Bundle 会提供 CLI，但不会创建账户、登录或改写 Claude 设置；配置与身份验证失败会公开其生命周期阶段与安全的 `unknown` 回退，而不会增加单独的公开分类。
- **委派时必须存在 SDK 平台载荷**——省略 optional dependencies 的安装、不受支持的平台以及缺失或损坏的载荷都会在第一次 query 时失败；不会回退到宿主 CLI。
- **没有人工交互路径**——`AskUserQuestion` 被禁用，权限提示会被拒绝，MCP elicitation 会被拒绝，阻塞对话会以拒绝方式失败而不会挂起。
- **assistant 载荷仅包含最终文本**——失败运行可以额外公开独立的安全诊断；推理、中间消息、工具通信、用量信息、stderr 和工作区差异仍只保留在产品内部，通用 Job id、通知与状态来自共享作业运行时。
- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。

<a id="dev-note"></a>

引擎准备成功后将解析出的厂商和模型选择记录到会话，供模型选择器投影使用；外部引擎没有原生 request/header 时，界面也不会回退显示目录默认模型。

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **载荷体积披露**——当前 darwin-arm64 平台载荷压缩后约 92 MB、解包后约 325 MB；这些是披露数字，不是安装阈值。
- **版本锁定的协议**——运行时依赖锁定为 Agent SDK 0.3.263；升级会锁定新的 SDK 版本，并需要重新运行无密钥真实产品与 loader 组合证据。

</details>

**运行时不变式：** 不发布伴生入口。生命周期配对属于共享 subagent 服务，受管范围的所有权属于 subprocess 服务。
