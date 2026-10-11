# Agent Note: 未指定推理等级时解析为所提供的 High 或 XHigh

Status: implemented

English | [中文](2026-10-08-implied-default-reasoning-effort.md)

## 问题

若某条路由提供 `high` 或 `xhigh` 推理等级却没有配置默认值，所有请求都不会带上该参数。模型选择器显示 **Default** 项，ACP 显示 **Provider default**，实际采用的等级取决于各引擎自身的行为——Claude Code 的内部默认、Codex 的默认，或网关的默认。显示状态与请求之间没有任何关联：同一个「Default」既可能出现在按 `high` 思考的路由上，也可能出现在完全不思考的路由上；而想要固定某一等级的部署，还得在本来就已列出该等级的 `reasoningEfforts`／`defaultReasoningEffort` 之外重复声明一次。

## 决策

**由推理元数据的生产者命名推导出的默认值。** `@deepseek-ai/dsh-llm` 中的 `impliedDefaultEffort(efforts)` 返回所提供可选标识中最强的 `xhigh`，其次是 `high`（按小写比较，因此路由可以写作 `High`）；两者都不提供时不返回任何值。当 profile 未配置 `reasoning` 时由 `llm-pi-ai` 调用它；当部署与适配器都没有给出可提供的默认值时，`mapEngineReasoning`（位于 `@deepseek-ai/dsh-agent`，服务于 Claude 与 Codex）回落到它。`llm-replay` 与线上路由保持一致，使录制会话能够匹配。

消费方无需改动，因为它们本来就读取 `LlmModelReasoningInfo.defaultEffort`：`SessionController.modelCatalog` 对外公布该等级，`selectModel` 将其物化进选择，选择器去掉「提供商默认」项，ACP 去掉 **Provider default** 选项。`/model` 弹窗与输入区席位读取同一个目录。

推导发生在元数据生产者一侧，而不是 `LlmRuntime.normalizeModelInfo`中。因此，若适配器配置的等级是该精确模型无法接受的，它仍然报告没有默认值，请求路径也仍以 `UNSUPPORTED_REASONING_EFFORT` 拒绝该部署值，而不会悄悄替换成别的等级。显式配置的默认值同样优先；配置了却不在可选集合中的默认值，在引擎映射解析时仍然抛错。

## 备选方案

- **在 `LlmRuntime.normalizeModelInfo` 中推导**——否决：元数据归一化无法区分「未配置默认值」与「配置了但该精确模型拒绝」，推导出的等级会覆盖掉 `llm-pi-ai` 有意在请求阶段拒绝的那个部署值。
- **在浏览器或各消费方中推导**——否决：选择器、ACP 和会话控制器都要各自实现这条规则；而从不重新选择模型的会话仍会什么都不发送，选择器却显示着某个等级。
- **让 `high` 优先于 `xhigh`**——否决：既然路由提供 `xhigh`，采用最强默认的引擎就会落到该等级；优先 `high` 等于声明了比路由公布更弱的等级。
- **为推导的标识提供配置开关**——未采纳：想要端点未指定默认值的路由，只需不提供这些标识即可表达该意图；重命名标识（例如 `max: xhigh`）也仍能保留该等级。

## 结果

放弃的是：路由不能再在提供 `high`／`xhigh` 的同时发送未指定的等级——该等级会被物化、与模型一起保存为新会话的默认值并显式发送，在网关原本默认更低时可能提高成本。换来的是：显示的等级与下发的参数一致，部署也不必在等级集合旁重复声明默认值。

验证：`packages/llm/llm/tests/reasoning-default.spec.ts` 覆盖标识匹配与优先级；`packages/llm/llm-pi-ai/tests/adapter.spec.ts` 与 `catalog.spec.ts` 覆盖未配置路由、已配置路由与拒绝场景；`packages/core/agent/tests/engine-reasoning.spec.ts` 覆盖引擎回落，以及对不在集合中的已配置默认值的严格拒绝；Web 场景 `declared-reasoning` 覆盖选择器。迁移见 `implied-reasoning-default` 升级指南。
