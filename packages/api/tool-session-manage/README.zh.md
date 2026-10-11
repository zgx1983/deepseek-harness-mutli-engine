---
description: "面向模型的项目、引擎与模型目录工具，以及对话式会话创建：让部署允许模型在已知项目中打开新会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-manage

[English](README.md) | 中文

## 概述

使用 `dsh-tool-session-manage` 让模型回答类似“在 alpha 项目里用 codex 引擎和 glm-5 模型新建一个会话”的请求。三个只读目录工具——`list_projects`、`list_engines` 与 `list_models`——把口述名称解析为 id；`session_create` 在已注册项目或绝对目录中创建一个用户可见的会话，并可选择在第一条用户消息之前固定其引擎、模型与标题。目标项目里已挂载的匹配空白会话会被收养，而不是重新创建。该包在 Web 应用中默认启用。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型应当自行解析项目、引擎与模型身份并代表用户打开会话时挂载本包。它在进程内调用宿主会话与工作区服务，因此属于同时挂载 `dsh-api-session-controller` 与 `dsh-workspace` 的组合——出厂 Web 应用正是如此。

### When to choose it

当需要端到端的对话式会话创建时选择它：目录工具把自然语言名称解析为 id，`session_create` 提交它们。没有会话控制器或工作区注册表的组合（例如 headless 档位）不适合本包：插件无法解析其服务。

### Configuration

本包不接受配置：所有可调选择（空白复用、按引擎过滤的模型目录、错误恢复引导）都是固定行为。

### What the model can do

| 工具 | 模型获得的内容 |
|---|---|
| `list_projects` | 每个已注册项目工作区：id、路径、标题与会话数 |
| `list_engines` | 新会话可选的每个引擎：id、名称与可选描述 |
| `list_models` | 部署默认选择与按 provider 分组的模型，可按某引擎可路由的 provider 收窄 |
| `session_create` | 一个已创建（或复用的空白）会话 id，以及按请求解析出的引擎、模型与标题 |

### Failures and recovery

参数配对错误（workspace 与 cwd 二选一、provider 与 model 成对）在任何服务调用之前以 `SESSION_MANAGE_INVALID_ARGS` 失败。未注册的工作区、引擎或模型返回各自的 `SESSION_MANAGE_*` 代码以及下一步该调用的目录工具；未知服务故障收敛为 `SESSION_MANAGE_TOOL_FAILED`，诊断只进入宿主日志。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

`list_*` 读取 `ctx.workspaceRegistry.list()` 与 `ctx.sessionController.engineCatalog()` / `modelCatalog(engineId?)`，把条目裁剪为模型可操作的字段。`session_create` 复刻 Web 客户端的空白复用判定——空白、同一规范 cwd、已挂载到目标工作区、未归档——然后通过显式 id 的 `create` 收养该会话；收养竞态（`session/writer-held`、`session/engine-conflict`、`session/conflict`）回退到全新创建。引擎在第一条用户消息之前随 create 请求固定，因此模型选择与重命名始终运行在未锁定、空闲的会话上。

`serviceBoundary` 包装保留取消、记录完整诊断，并把已知 `RemoteError` 代码翻译为模型可恢复的引导；原始 provider 或持久化文本不会到达模型。成功的 `session_create` 结果还通过 `output.presentationMeta` 持久化为 `tool/result` 的 `meta`，供 Web 卡片回放稳定渲染。

</details>

-----

<a id="further-exploration"></a>

## 进一步探索

包级契约不够时阅读以下页面。

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-manage) — 模型所见到的四个工具 schema。
- [dsh-api-session-controller](../session-controller/README.zh.md) — 这些工具调用的会话命令与目录。
- [dsh-workspace](../../workspace/workspace/README.zh.md) — `list_projects` 与空白复用背后的项目注册表与归档状态。
- [dsh-client-ui-session-manage](../../client/ui-session-manage/README.zh.md) — `session_create` 结果的 Web 卡片。
- [主 agent 引擎与模型选择](../../../docs/main-agent-engines.zh.md) — 引擎如何锁定、模型目录如何保持引擎相关。

-----

<a id="model-experience"></a>
## 模型体验

### System prompt

#### What the model sees

模型收到一段固定的组合引导。

##### 组合引导

```markdown
When the user names a project, engine, or model by voice, resolve each with list_projects, list_engines, and list_models, then pass the resolved ids to session_create instead of the spoken names. Requests to create or open a user-visible session belong to session_create; reserve teammates for requests that explicitly ask for Agent Teams.
```

#### Token effect

插件挂载期间每次请求携带一段固定的简洁段落。

#### KV Cache effect

插件与引导文本不变时前缀稳定。

### Tool schemas

#### What the model sees

模型看到生成的 [`list_projects`、`list_engines`、`list_models` 与 `session_create` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-manage)。目录参数保持最小——`list_models` 只接受可选的引擎 id——而 `session_create` 声明基于 id 的位置、引擎、模型与标题字段，并声明它创建的是用户可见的顶层会话，而非 teammate。

#### Token effect

可见期间每次请求发送四个固定 schema。

#### KV Cache effect

工具可见性与定义不变时前缀稳定。

### Tool results

#### What the model sees

目录调用返回有界 JSON 对象（项目、引擎或按 provider 分组的模型）；`session_create` 返回创建的会话 id、解析出的引擎与模型、接受的标题，以及是否复用了空白会话。错误携带一个稳定的 `SESSION_MANAGE_*` 代码与恢复引导。

#### Token effect

结果取决于数据，并保留在已记录的工具历史中直到压缩；目录大小跟随部署已注册的项目、引擎与模型。

#### KV Cache effect

追加式结果文本位于可复用请求前缀之后，不会使更早的缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包何时不适用或需要特别运维注意。它们是当前的包约束，不是任务积压。

- **仅限 Web 组合的服务** — 插件依赖 `sessionController` 与 `workspaceRegistry`，两者随 Web 应用组合发布；headless 或 SDK 档位必须显式挂载它们。
- **对话请求即授权** — `session_create` 不询问确认，与“新建会话”按钮一致；需要确认步骤的部署应添加 `tools/pre-execute` 审批监听。
- **不提供导航** — 工具创建会话，Web 卡片提供打开入口；模型自身不能切换用户当前的视图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: model-driven navigation

是否应有一个后续工具让模型切换 Web 客户端当前激活的会话（而非仅在结果卡片上提供打开动作）尚未决定；那将新增一条 Host 到 Client 的请求通道。

</details>

**Runtime invariant:** 未发布配套 invariant。这些工具是只读目录适配器加一个委托宿主会话控制器完成全部持久写入的创建工具；会话持久化及其不变量由控制器自身负责。
