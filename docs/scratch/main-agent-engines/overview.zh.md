# 可插拔主 Agent 引擎方案

[English](overview.md) | 中文

状态：待实施设计参考，不代表现有功能。负责人：主 Agent 引擎实施者与架构评审者。创建：2026-09-29。复审或到期：2026-10-29。实施后的归档目标：架构、核心子系统及引擎包文档。到期需要复审，不自动删除。

<a id="summary"></a>

## 概要

允许主聊天选择 DSH 原生循环、Claude Agent SDK 或 Codex provider。DSH 管理聊天应用和可观察记录，选中的引擎管理执行。需要先修改公共 API，随后各 provider 才能成为独立安装的插件。用户消息不经过子代理委派工具。

<a id="contents"></a>

## 目录

- [调研依据](#evidence)
- [架构](#architecture)
- [设计选择](#decisions)
- [实施交接](#handoff)

<a id="evidence"></a>

## 调研依据

仓库依据来自源码检查，未运行外部引擎。[AgentFactory](../../../packages/core/agent/src/index.ts) 已提供创建和恢复，但 `setFactory()` 拒绝第二个工厂。[Agent](../../../packages/core/agent/src/runtime-types.ts) 包含队列、取消、维护、steering 和上下文注入义务。[AgentLoop](../../../packages/core/agent-loop/src/index.ts) 管理创建并注册 inbox/turn 投影。[Session commands](../../../packages/api/session-controller/src/commands.ts) 经 `ctx.llm` 解析模型并生成原生分支 seed。

现有 [Claude provider](../../../packages/subagent/subagent-claude-code/src/run.ts) 使用 SDK 0.3.263，禁用持久化并按无人交互处理。现有 [Codex provider](../../../packages/subagent/subagent-codex/src/run.ts) 使用 app-server，固定运行时版本为 0.153.4。两者都是一次性子代理。主引擎确有需要时再提取进程和协议公共代码；仅返回最终答案的行为不能充当主聊天适配器。

2026-09-29 查阅的官方资料：[Claude 会话](https://code.claude.com/docs/en/agent-sdk/sessions)、[Claude 权限](https://code.claude.com/docs/en/agent-sdk/permissions)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) 和 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。在线文档可能描述高于仓库固定版本的功能；实施时必须验证固定版本，不假设与文档一致。

<a id="architecture"></a>

## 架构

```text
Web / Desktop / DSH SDK
          |
Session API + engine capability checks
          |
Agent registry + named factory routing
     /             |              \
native loop    Claude SDK      Codex provider
     \             |              /
      durable chat events + UI projections
```

在 `dsh-agent` 增加具名工厂和引擎能力。`dsh-agent-loop` 保留为原生 provider。拟议 `dsh-agent-runtime` 承载可复用生命周期和队列机制，在确认原生行为保持后逐步提取。拟议 `dsh-agent-claude` 和 `dsh-agent-codex` 负责外部执行。provider 经 Cordis effect 注册，Bundle 安装配置及固定版本依赖。应用仍通过 `dsh` profile 启动。

<a id="decisions"></a>

## 设计选择

Claude 使用 Claude Agent SDK。交互式 Codex 主聊天优先采用 App Server，原因是它提供审批和运行中回合控制。严格使用 `@openai/codex-sdk` 的 provider 仍是可选方案，能力限定为逐轮对话、可观察 item 流和经验证的取消及恢复。App Server 是建议的通信方式，不代表 TypeScript SDK 提供相同方法。

引擎标识独立于 LLM provider/model 持久化。首版固定每个会话的引擎。全局默认值变更仅影响新会话。跨引擎转移创建新会话并明确记录摘要，不是无损恢复。初期外部原生工具仍由引擎管理，DSH 工具桥接作为后续能力。模型注册是 endpoint 感知的：provider 适配器声明具名 endpoint，每个引擎 definition 绑定其服务的 endpoint，不同 agent 由此路由到不同 provider，互不共享凭证或 base URL。

当前[架构](../../architecture.zh.md)要求从 Session 日志重建模型输入。外部 SDK 输出不足以满足该保证。提议外部会话记录提交输入及可观察执行，由引擎原生数据负责准确续接。实施前必须对该例外进行明确的架构与 invariant 评审；DSH 原生保证保持不变。

<a id="handoff"></a>

## 实施交接

以[详细设计](detailed-design.zh.md)作为拟议行为规范，以[实施计划](implementation-plan.zh.md)作为有序任务包。文档明确标出验证关口，轻量模型必须在这些位置停止推断，不能编造 SDK 行为。本次文档变更不包含引擎代码、外部调用或运行时验证。
