---
kind: upgrade-guide
description: "提供 `xhigh` 或 `high` 但未配置默认值的路由，现在会发送该等级，而不是不发送推理参数。"
---

# 推理等级默认为 XHigh 或 High

[English](guide.md) | 中文

## 变更

如果某条路由提供 `xhigh` 或 `high` 推理等级，却没有配置默认值，现在会把两者中最强的那个当作默认值——优先 `xhigh`，按小写比较可选标识——因此未指定等级的会话会被物化为该等级，与模型一起保存为新会话的默认值，并显式发送给引擎。

此前省略等级时，请求会不带该参数到达端点，模型选择器中显示 **Default** 项（ACP 中为 **Provider default**）。只有当路由两个等级都不提供时，该项才会保留。

受影响的用户：凡是路由的 `reasoningEfforts`（或继承的 Harness 等级）包含 `high` 或 `xhigh`，而 `llm-pi-ai` 的 `reasoning` 与引擎的 `defaultReasoningEffort` 都未设置的人。他们的请求现在会带上此前不带的等级，这会改变模型行为，也可能提高成本。显式配置的路由默认值仍然优先；适配器配置的等级若该精确模型无法接受，仍会以 `UNSUPPORTED_REASONING_EFFORT` 拒绝。

## 迁移

1. 若希望继续沿用端点自身的未指定默认值，就不要让这两个等级作为可选标识出现：在 `reasoningEfforts` 中重命名标识，例如 `{ off: null, standard: high, max: xhigh }`。选择器随后会保留「提供商默认」项。
2. 若要固定 Harness 现在推导出的等级，请显式声明：`reasoningEfforts: { off: null, high: high, xhigh: xhigh }`，并在 Claude 或 Codex 引擎上设 `defaultReasoningEffort: xhigh`，或在 `llm-pi-ai` 上设 `reasoning: xhigh`。
3. 在会话日志中确认 `request/header` 携带了预期的 `reasoningEffort`，并确认选择器中勾选的行与之一致。
