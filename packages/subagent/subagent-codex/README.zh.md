---
description: "面向用户与维护者的一次性 Codex subagent 提供方，用于选择产品后端、安装 Profile bundle 或配置无人值守的 Codex 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-codex

[English](README.md) | 中文

`/startup` Cordis 入口注入 `agents`、`llm`、`credentials` 和 `subprocess`，注册 Codex 主对话引擎。部署字段为 `provider`、`model`、`env`、`mirrorUserInstructions`、`projectDocFallbackFilenames`、`autoCompactContextRatio`、`permissionMode` 和 `disposeGraceMs`。主引擎入口不注册子代理厂商。

## 概述

当委派工作需要在父会话工作区中的真实无人值守 Codex 会话内运行时，把 `@deepseek-ai/dsh-subagent-codex` 安装进 Profile。每次委派都会为一个自包含文本任务使用全新且隔离的 Codex 线程，并且只返回其最终答案或安全失败诊断。原生 Codex 配置和身份验证继续作为权威来源，而 `permissionMode` 选择非交互式审批和沙箱行为。Bundle 会提供兼容的原生 Codex 载荷，但只有配置委派工具后才会向模型公开相应能力。

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

当委派应以父级工作区中的真实 Codex 会话运行时，挂载本提供方。常用路径是显式的：把 Bundle 安装进 Profile，可选地配置提供方行，并通过委派工具行把它暴露给模型。

### 安装 Bundle

把包安装进目标 Profile，然后重启该 Profile。安装会把官方 wrapper 与一个兼容的原生平台载荷带入 Profile；声明的 patch 层只注册休眠的提供方，不启动任何 Codex 进程。

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh --profile <name>
```

移除包后，下一次 Profile 启动会撤回提供方及其私有运行时闭包。安装决定 Host 可用性，而不是模型权限：模型只能通过你组合的委派工具行触达提供方。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `codex` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `model` | Codex 原生设置 | 为本提供方实例的每个线程固定的可选非空模型名称；省略时不发送 app-server 覆盖 |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式子进程环境 |
| `permissionMode` | `never` | 为本提供方实例的每个线程固定的原生非交互审批与沙箱模式 |
| `disposeGraceMs` | `3000` | 共享 managed-range owner 各终止层级之间的宽限 |

| `permissionMode` 值 | `thread/start` 字段 | 原生行为 |
|---|---|---|
| `never` | `approvalPolicy: never`；省略 sandbox | 永不请求审批；在原生 sandbox 下发生的执行失败会返回给模型 |
| `approve-for-me` | `approvalPolicy: on-request`、`approvalsReviewer: auto_review`、`sandbox: workspace-write` | 由 Codex 自动评审权限请求，不等待人工 |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`、`sandbox: danger-full-access` | 跳过审批与 sandbox；必须显式选择该值 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-codex)是每个受支持字段及其 JSDoc 的穷尽式真源。已配置的 `model` 会原样传给每个临时 `thread/start`；省略时保留原生模型选择。提供方不会发现模型、改写别名、选择 `modelProvider` 或 `serviceTier`，也不会设置 fallback。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的 API 密钥必须在该配置中显式提供。

### 主引擎端点解析

导出的主引擎工厂读取会话选择的厂商；没有选择时使用部署的厂商覆盖值。两者均缺失时，必须恰好有一个路由声明 `openai-compatible`；路由缺失或存在歧义会在启动前失败。工厂经凭证服务解析路由的凭证引用，并优先使用会话选择的模型，其次使用部署默认值。Codex 接收私有 `model_providers.dsh_engine` 配置，通过 `DSH_CODEX_API_KEY` 接收解析后的密钥；命令参数不含秘密。 显式引擎环境配置覆盖注入值。Bundle 的 `apply()` 继续挂载一次性子代理 provider；使用主引擎工厂需要单独注册引擎。

### 暴露工具

每个委派工具行指名一个提供方，并需要独立的 `toolName`，因此模型看到的是静态工具，而不是动态提供方选择器。完整 Agent Preset 携带对应的默认工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent 暴露 `subagent_codex`。

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`one-shot` 策略会让省略 `run_in_background` 或传入 `false` 的调用继续在前台等待，而显式传入 `true` 会返回由父 agent 拥有的 Job id，供 `job_output` 或 `job_kill` 使用；base host（基础宿主）与完整 preset 已提供通用作业注册表和控制工具。

### 你会得到什么

前台调用会把选定的最终 Codex 答案交给模型；运行失败时则返回带停止原因与可选安全诊断的错误。后台调用先返回 Job id；随后通用作业控制面会送达完成通知，并通过 `job_output` 公开同一最终答案或失败状态。Codex 的过程说明、推理、工具活动、原始 stderr 与工作区差异绝不会进入父级会话。

### 失败与恢复

省略 optional dependencies、当前平台不受支持或所选载荷缺失的安装会让提供方保持休眠，并在第一次委派时于 `initialize` 阶段以安全 `unknown` 类别和任何已观测进程结果失败；不存在宿主 CLI 回退。原始 wrapper 文本只保留在 Host stderr。被取消的运行以 `aborted` 结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方如何驱动真实 Codex app-server，以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **每次运行一个全新进程、线程与轮次。** 每次运行都会 spawn 全新 app-server、创建一个临时线程并恰好执行一个轮次；没有续接、恢复或池化。
- **原生配置是权威。** Codex 配置与身份验证经父级 cwd、`HOME` 与 `CODEX_HOME` 保持原生；提供方只覆盖可选模型以及线程的 approval、reviewer 与 sandbox 字段。
- **刻意无人值守。** 审批、用户输入与 MCP 请求都会在无人参与的情况下被应答或拒绝；未知服务器请求会使运行失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：config schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | 运行生命周期、轮次执行、结果选择与诊断 |
| [`src/wire.ts`](src/wire.ts) | 最小的 app-server JSON-RPC 协议实现 |
| [`tsdown.config.ts`](tsdown.config.ts) | 分别打包提供方与主引擎入口；发布文件不依赖共享 chunk。 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册休眠提供方的 Profile patch 层 |

### 运行流程

一次启动只接受非空的文本块序列，并根据父会话确定子级 cwd。它经子进程 seam spawn 固定命令，完成 `initialize` → `initialized` 握手，把 Profile 选择的模式与可选模型映射为官方 `thread/start` 字段并与 `{ cwd, ephemeral: true }` 一起发送，且仅在 Codex 返回有效的临时线程后发布运行。已发布的结果恰好启动一个轮次，只接受与此次运行的线程和轮次匹配的通知，并等待权威的 `turn/completed` 终态。以最后一条 `phase: "final_answer"` 的 `agentMessage` 为准；若 Codex 没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退。成功完成的轮次若没有非空白答案，结果也会判为错误。失败轮次使用粗粒度类别 `limit`、`access-policy`、`service`、`transport`、`product-error`、`invalid-result` 或 `unknown`；app-server 提前退出使用 `process`，适用的连接与 stream 失败保留数值 `httpStatusCode`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方逐步进入它接入的 seam 与兄弟产品提供方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Claude Code subagent 提供方](../subagent-claude-code/README.zh.md)——经官方 Agent SDK 的兄弟产品后端。
- [Claude Code 与 Codex 后端](../../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)——产品提供方的设计记录。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-codex)——每个受支持配置字段及其源声明。

-----

## 主对话执行

输入框列出已映射的 Codex 操作及通过 `skills/list` 查询的工作区已启用技能。`/compact` 调用 `thread/compact/start` 并等待轮次终止通知。`/review [说明]` 进入持久输入通道并调用同一线程的 `review/start`；不带参数时审查未提交变更，参数用于自定义审查说明。审查输出流入主对话。技能命令在 `turn/start` 中转换为 `$name` 文本标记及准确路径的原生 `skill` 输入。禁用技能不显示，重名技能使查询明确失败。技能调用路径在使用前作为 `engine/item-settled` 命令目录元数据记录。线程原生操作在执行前通过 `thread/resume` 应用变化的模型及思考参数；普通技能轮次携带当前轮次覆盖参数。Codex 斜杠解析属于 TUI 功能；未适配的 CLI 命令不展示。app-server 通过 `collaborationMode/list` 发布协作模式时，`/plan` 记录原生协作模式，其后的每个 `turn/start` 携带 `{ mode, settings: { model, reasoningEffort? } }`，模式自下一轮生效，`off` 回到 `default`；缺少该接口的构建不展示该命令，`/plan` 返回明确的不支持原因。原生 `skills/changed` 通知使客户端目录缓存失效。图片附件从已授权的附件存储读取，并作为 data URL 传入 `turn/start`，服务器收到图像字节而无法访问私有附件路径。已省略图片使用纯文本附件提示；此引擎暂不支持通用文件附件。

`./startup` 提供者独立于单次委派注册持久且可交互的主对话驱动。它将选定提供者的 Responses 地址、凭据环境引用、模型及推理等级传入固定版本的 Codex app-server。所选模型的已解析上下文窗口也会作为 `model_context_window` 传入，并由部署字段 `autoCompactContextRatio`（默认 `0.9`，与 Claude 引擎一致）推导出 `model_auto_compact_token_limit`，因此自定义 Responses 路由会按会话上报的同一窗口触发压缩；路由配置或精确模型覆盖可固定这两个值，窗口未知的模型则两者都交给原生默认。一个共享的 app-server 子进程服务所有普通会话：它在进程启动时初始化，每个对话以原生线程挂载到它上面，因此多个对话只需一个子进程，而不是每个会话一个。共享子进程在 `$DSH_HOME/engines/codex/shared-home` 携带一份原生目录，其中的 SQLite 与日志目录为各线程共享；更早的 rollout 会从遗留根目录及会话旧的按会话目录只读迁入，已提交的生成物只会被拷贝、不会被移动。恢复时校验原生标识和工作区，并传入确切的历史文件路径。旧共享存储仅迁入匹配的历史文件，不复制数据库、认证、配置或其它历史。已有消息但缺少原生历史时会报错，不会创建新线程。文本、推理、用量及原生命令/文件活动映射到共享对话流。token 用量通知在运行时报告时还会携带原生上下文窗口；在此之前以准备好的模型目录中解析出的上下文窗口为准。部署 `permissionMode` 保留为旧适配器设置；托管主对话直接把会话实际生效的权限预设翻译为原生线程权限，引擎不读取宿主机 `~/.codex/config.toml` 或 `~/.codex/rules`，宿主权限字段无法限制或重新定义会话。每次准备时，引擎会把宿主机 `~/.codex/AGENTS.md` 镜像进该目录，使原生全局指令像直接运行 CLI 一样被加载；部署字段 `mirrorUserInstructions: false` 可关闭该镜像。项目级 `AGENTS.md` 仍按工作区正常解析，同时 app-server 会收到 `project_doc_fallback_filenames`，因此只用 `CLAUDE.md` 记录约定的仓库也能加载同一份指令；部署默认值为 `CLAUDE.md`。

沙箱直接映射为 `thread/start` 或 `thread/resume` 的 sandbox；人工审核使用 `approvalPolicy: on-request` 及 `approvalsReviewer: user`，Never 使用 `never`，Auto 使用 `on-request` 及 `auto_review`。会话权限预设是唯一权限来源并决定每个线程字段：宿主 `~/.codex/config.toml` 与 `~/.codex/rules/*.rules` 中的任何内容都不会进入会话目录，宿主配置既不能限制也不能改写所选权限；授予完全权限的会话始终以 `sandbox: danger-full-access` 加 `approvalPolicy: never` 运行。命令、文件、权限审批及非秘密用户提问的回复关联到其所属原生轮次。未知交互会拒绝执行。

主引擎的 `providers` 字典以已注册的 LLM 路由为键，支持 `httpHeaders`、`headerCredentialRefs`、`queryParams`、重试和流超时配置、`supportsWebsockets`、模型上下文/压缩/推理摘要/输出详略元数据，以及 `models` 下按确切模型名设置的覆盖项。请求头凭据在替换进程前解析，仅通过子进程环境变量传递。`subagentModel` 和 `subagentReasoningEffort` 分别传入原生 `agents.default_subagent_model` 和 `agents.default_subagent_reasoning_effort`，用于 Codex 内部子代理，独立于 Harness 委派。主模型由会话选择，通过线程及轮次 RPC 字段传递。

仅模型名变化且路由与线程设置相同时，保持在共享线程上，更新 `turn/start.model`。在已注册路由之间切换提供者、或权限变化时，通过 `thread/resume` 以新的原生值重新挂载线程。配置或凭据漂移会在轮次之间重启共享子进程，随后每个会话重新挂载；与进行中原生轮次冲突的变化会大声失败，待该轮次结束后重试。携带 Harness Team 工具的对话保留专用的按会话子进程及按会话替换语义。`/model` 选择器与原生目录均使用 Harness 模型目录。

共享子进程每次启动会解析每条已注册路由的 Responses endpoint 提供的模型，并把各路由目录合并为一份 `models.json`，在共享原生目录中原子写入并通过 `model_catalog_json` 传入其绝对路径；同一个模型 ID 被两条路由提供时启动失败。上下文、推理等级和模态在可用时来自实时 LLM 元数据；未列出的选定名称无法解析元数据时，会以该名称作为目录 ID 和显示名称。路由和确切模型配置在目录中覆盖原生上下文、压缩、摘要及输出详略字段。先前选定的未列出名称按路由保留在共享目录中，在不重启子进程的情况下刷新其元数据。初始化在子进程启动时通过原生 `model/list`（包括分页）一次性核对每个预期 ID；缺少 ID 或提供方目录不可用时启动失败。

`catalogInstructions` 提供生成目录的编码指令，`catalogTruncationTokenLimit` 默认将工具输出截断预算设为 10,000 token。路由或确切模型的 `modelInstructions` 和 `modelTruncationTokenLimit` 可覆盖这些默认值。在任何提示词发送前，已确认的目录以类别为 `model-catalog` 的 `engine/item-settled` 记录写入会话，使编码指令可从 Harness 会话重建；原生历史也保留实际生效的指令。生成目录不含 endpoint 凭据，也不修改用户的全局 Codex 配置。

## 原生子代理状态

主 wire 识别当前 `collabAgentToolCall` 与旧版 `collabToolCall`，记录接收方身份和原生代理状态，并在父线程过滤前处理已知子线程通知。启动或等待工具调用完成本身不代表子代理完成。恢复时根据可用的原生线程 item 重建接收方关系，将历史未结束状态视为未知。已知子线程的授权及提问使用所属进程的生命周期，无关线程仍被拒绝。子代理输出受 `maxActivityCharacters` 限制，`activityUpdateIntervalMs` 控制输出观察频率，默认 100 ms。不额外启动 app-server、不增加原生轮询循环、不修改配置目录。详情完整度取决于已安装服务器版本发布的通知；尚不提供直接向子代理发送消息或面向用户的子代理控制。

主引擎的 `providers[provider].reasoningEfforts` 将可选标识映射为 app-server 程度字符串；null 映射为 `none`。`defaultReasoningEffort` 指定可选默认标识，`models[exactModelId]` 可覆盖任一字段。没有覆盖时继承适配器的协议映射及兼容默认值。`resolveCodexModelCatalog` 使用映射值生成原生可选及默认等级，并保留相同的逐模型映射供准备过程使用。映射值每轮通过 `effort` 传递，专用 team 会话子进程还会在启动时以 `model_reasoning_effort` 固定该值；重新挂载保留绑定的原生线程。这些字段不会修改 `subagentReasoningEffort`。参见[配置示例](../../../docs/main-agent-engines.zh.md#engine-reasoning-mapping)。

`./startup` 入口在子代理服务可用时还会注册 `engine:codex`。它通过主对话驱动运行持续子代理，使每个子代理具有自己的持久 Harness Session、隔离 Codex home、原生 thread 绑定、活动流、授权、提问、中止与冷恢复。包根的旧一次性 provider 保持独立。委派 Agent 参数指定子代理厂商、模型和思考程度。

主会话通过目录链接将 `~/.codex/skills` 和 `$DSH_HOME/skills` 合并到隔离的 `$CODEX_HOME/skills`；同名文件夹优先采用原生全局目录。项目 `.agents/skills` 和用户 `~/.agents/skills` 的原生发现仍可用。已有真实文件夹和无关链接保留，准备引擎时移除失效的受管链接。源文件修改直接可见，不复制技能正文。

压缩通过原生活动记录展示进度与完成状态，不生成虚构的助手回复。对话与轨迹会本地化 `contextCompaction` 操作。失败和中止会在释放操作前结束剩余命令活动。只公开已映射的 app-server 命令及发现的已启用技能；仅 CLI 提供的命令没有通用斜杠命令透传。

拥有作用域内 Harness Team 工具的主对话保留专用的按会话 app-server 子进程，因为其按代理的 `mcp_servers.dsh_team` Streamable HTTP 连接需要私有进程；普通会话共享进程级子进程。认证来自进程环境中的请求头，不持久化。`teamToolTimeoutMs` 配置 MCP 截止时间，默认 3,660,000 毫秒；启动时必须成功连接。该服务的原生 MCP 权限显式允许；调用仍以所属 Harness Agent 身份经过 Harness 工具策略及 Team 授权，turn 结束时等待未完成调用结束。冷恢复及厂商变更导致的重启会重建连接，保留原生 thread。

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

Codex 子级会在一个全新的临时线程中，以单个轮次接收这些独立文本块。它的工作区是父会话 cwd；所选提供方实例会固定已配置的模型、环境、非交互审批策略与沙箱模式，而省略的模型及其余产品设置来自 Codex 原生配置。可执行版本来自 Bundle 锁定的平台载荷。

#### Token 影响

子级需为独立的 Codex 上下文和轮次承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 Codex 自身的提供方、模型、指令、工具和临时线程请求。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，前台调用会让父级模型看到选定的 Codex 最终答案；若结果未完成，错误中会包含终止原因和可选的安全诊断。该诊断可以区分粗粒度行动类别、协议阶段、适用的数值 HTTP status 和已观测的进程结果，而不复制产品正文或 stderr。后台调用会先返回 Job id；随后通用作业控制面会送达完成通知，通过 `job_output` 公开同一最终答案或失败状态详情，并允许 `job_kill` 请求取消。Codex 的过程说明、推理（reasoning）、工具活动、原始 stderr、工作区差异、用量信息、产品标识符、命令、路径和协议载荷均不会复制到父会话。

#### Token 影响

前台输入会增加工具结果中保留的最终答案或错误内容。后台输入还会包含启动确认、完成通知，以及 `job_output`、`job_kill` 或后续状态结果；子任务 token 仍不会进入父级上下文。本提供方自身不添加父级工具 schema。

#### KV Cache 影响

仅追加：前台会在可复用的父请求前缀后增加一个结果，后台则会继续追加 Job 启动确认、通知以及后续控制或收集结果。后台调度可能增加一个由通知唤醒的轮次，但这些消息都不会改写更早的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 Codex 对比或任务积压。

- **每次运行均新建一个进程、一个线程和一个轮次**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改提供方与模型，而且每个公开工具都需要唯一的 `toolName`。
- **身份验证与账户状态仍由原生机制管理**——Bundle 会提供 CLI，但不会创建账户、登录、信任项目或改写 Codex 设置；配置与身份验证失败会公开其生命周期阶段与安全的 `unknown` 回退，而不会增加单独的公开分类体系。
- **委派时必须存在原生平台载荷**——省略 optional dependencies 的安装、不受支持的平台以及缺失或损坏的载荷都会在第一次运行时失败；不会回退到宿主 CLI。
- **兼容性由开发证据锁定**——若要从已验证的 0.153.4 协议基线升级，必须重新生成上游 schema 证据，并重新运行握手、答案选择、审批、取消、无密钥真实产品以及带密钥的 DeepSeek 随机数测试。
- **没有人工审批路径**——已知的无人值守审批请求会被拒绝，未知服务器请求会以默认拒绝方式使运行失败；三种 Profile 模式都不会创建 DSH 交互通道或逐次调用 allow 策略。
- **assistant 载荷仅包含最终文本**——失败运行可以额外公开独立的安全诊断；推理、过程说明、中间消息、工具通信、用量信息、原始 stderr 和工作区差异不会进入父会话，通用 Job id、通知与状态来自共享作业运行时。
- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。

<a id="dev-note"></a>

引擎准备成功后将解析出的厂商和模型选择记录到会话，供模型选择器投影使用；外部引擎没有原生 request/header 时，界面也不会回退显示目录默认模型。

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **载荷体积披露**——当前 darwin-arm64 平台载荷压缩后约 114 MB、解包后约 282 MB；这些是披露数字，不是安装阈值。
- **版本锁定的协议**——运行时依赖锁定为 `@openai/codex@0.153.4`；升级需要重新生成上游 schema 证据并重新运行带凭证的随机数测试。

</details>

**运行时不变式：** 不发布伴生入口。生命周期配对属于共享 subagent service，受管范围的所有权属于 subprocess service。
