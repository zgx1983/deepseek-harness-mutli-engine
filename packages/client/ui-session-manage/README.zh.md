---
description: "session_create 工具结果的 Web 卡片，带打开会话动作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-manage

[English](README.md) | 中文

## 概述

`dsh-client-ui-session-manage` 在 Web 对话中渲染 `session_create` 工具调用：调用进行时以紧凑行显示目标项目，成功后显示已创建会话的引擎、模型与标题，并提供导航到该会话的打开动作。一切都源自持久化的调用切片——宿主工具持久化的结果 `meta`——因此回放无需任何实时查询即可渲染同一张卡片。

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

本包随 Web 应用发布；没有用户配置。当 `session_create` 调用落定，其行内显示持久化 meta 中解析出的引擎、模型与标题，并对宿主会话列表仍然持有的会话提供“打开会话”。

### When to choose it

任何挂载了 `dsh-tool-session-manage` 宿主插件、并希望从结果卡片直达已创建会话的组合都应选择它。没有它时，`session_create` 结果仍通过通用工具卡片渲染，但没有打开动作。

### Failure behavior

结果 meta 缺失或畸形时退化为通用摘要文本且无打开动作；宿主列表不再持有的会话（例如已归档）同样隐藏动作，卡片永远不会指向失效的导航目标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

浏览器插件在 ui-tool 的 `tool.call.toolview` 键控槽中注册 `session_create` 线名，优先级为 `-10`，优先于 ui-tool 的通用详情行，带 `session-manage` 语言包命名空间与注入的 `openSession` 动作。`SessionCreateRow` 把宿主工具通过 `presentationMeta` 持久化的 `ToolResultNode.meta` 收窄为 `{ sessionId, engineId?, model?, title?, reused }`；仅当 id 仍在会话列表快照中时，打开动作才调用 `ctx.uiWorkspace.openSession`。进行中的行显示从调用参数解析的目标项目，参数缺失时回退到调用 id。

</details>

-----

<a id="further-exploration"></a>

## 进一步探索

包级契约不够时阅读以下页面。

- [dsh-tool-session-manage](../../api/tool-session-manage/README.zh.md) — 本卡片渲染其结果 meta 的宿主工具。
- [dsh-client-ui-tool](../ui-tool/README.zh.md) — 键控工具视图槽与通用回退卡片。

-----

<a id="model-experience"></a>
## 模型体验

None, as this browser UI registers no model-facing tools or messages; the Host `dsh-tool-session-manage` plugin owns every model-visible surface.

#### KV Cache effect

None. Card presentation does not enter model requests.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 卡片只呈现持久化结果 meta 携带的内容；旧版工具的回放没有该 meta 时渲染通用摘要且无打开动作。
- 打开动作不做二次确认；会话自身的归档状态是唯一护栏（已归档或已掉出列表的会话隐藏动作）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: richer created-session summary

卡片是否应显示工作区标题或复用空白标记（两者都在持久化 meta 中）尚未决定。

</details>

**Runtime invariant:** 未发布配套 invariant。卡片只渲染已记录的调用切片，自身不注册任何持久状态、服务存在性或事件关系。
