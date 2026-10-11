# 持久多引擎 Agent Teams：详细设计

[English](persistent-agent-teams.md) | 中文

设计参考，部分目标已实现；本稿不作为当前功能状态清单。当前行为见[所属包文档](../../../packages/experimental/tool-agent-team/README.zh.md)，已迁移与待完成项目见[功能迁移与迭代清单](../../../worktree-feature-list.md)。历史方案评审日期：2026-10-01；本次状态核对日期：2026-10-04。

## 摘要

Harness 负责团队成员、邮箱、共享任务和调度。每个 teammate 拥有持久 Harness Session，由原生 AgentLoop、Claude Agent SDK 或 Codex app-server 执行。持续对话复用生产主引擎驱动器，不使用外部一次性 subagent provider。成员可在空闲、中止或进程重启后通过 Session 身份重新唤醒。

## 目录

- [范围与当前缺口](#scope)

- [执行配置选择](#selection)

- [成员生命周期](#lifecycle)

- [邮箱与调度](#mailbox)

- [Claude 对接](#claude)

- [Codex 对接](#codex)

- [共享服务与持久化](#persistence)

- [引擎具备而 Harness 未承接的能力](#gaps)

- [实现任务与验收](#implementation)

<a id="scope"></a>

## 范围与当前缺口

已确定范围：持久成员、每成员独立引擎／厂商／模型、并行轮次、基于 Session 唤醒、成员消息、共享任务 DAG、人工授权、中止、恢复及统一 UI。建议首版：原生 Lead 配合任意三种成员引擎；外部 Lead 在团队工具桥接完成后接入。

当前 TeamRoster 调用 `subagents.startContinuable`，持久成员记录保存的是委派 provider。TeamMailbox 对 Lead 调用 `root.steer()`，对子成员调用 `steerHostSubagentPrompt()`。两个外部主引擎当前都拒绝 steering 和 fork。这些是具体集成缺口，不代表引擎不能恢复会话。

不要将现有 Team 成员的 `provider` 字段改作模型厂商。区分执行引擎（`native`／`claude`／`codex`）、模型厂商（注册的 LLM 路由）、模型 ID、已有委派 provider（`spawn`／`fork`）。历史团队保留原有 provider 行为。

<a id="selection"></a>

## 执行配置选择

### 可选方式

| 指定方式 | 优点 | 代价／建议 |
|---|---|---|
| 继承 Lead 选择 | 无需额外选择。 | 外部兼容性及成本可能不同；仅作为显式团队默认策略。 |
| 每次创建填写引擎／厂商／模型 | 最灵活。 | 模型容易编造 ID，用户需重复配置；保留为经允许的高级覆盖。 |
| 执行预设 | 稳定的具名选项，可按引擎分别配置。 | 建议作为公开入口；需增加一个简洁预设编辑器。 |
| 角色映射到预设 | 审阅／编码任务可选择部署默认值。 | 在预设之后扩展；角色仅作提示，不能从名字字符串猜测。 |

### 建议的首版入口

增加 Team 执行预设，与 `dsh --profile` 应用 profile 和 Agent 组合 preset 区分。用户在“设置 → Agent Teams”通过三个选择器配置：引擎、按 endpoint 兼容性过滤的厂商、精确模型。显示 endpoint 可用情况，不展示凭证。团队设置指定一个默认预设；创建成员时可选择其他允许的预设。

以下为建议配置数据示例，不是当前可直接使用的 Cordis 配置。引擎与模型厂商分别存储，由 Team 服务负责校验配置 schema。

```json
{
  "executionProfiles": {
    "reviewer-claude": {
      "engineId": "claude",
      "modelProvider": "deepseek",
      "model": "deepseek-flash",
      "permissionPreset": "read-only"
    },
    "coder-codex": {
      "engineId": "codex",
      "modelProvider": "deepseek",
      "model": "deepseek-v4-pro"
    }
  },
  "defaultExecutionProfile": "reviewer-claude",
  "allowedExecutionProfiles": ["reviewer-claude", "coder-codex"],
  "allowExplicitExecutionOverride": false
}
```

示例权限名称仅作说明，必须解析为已安装的权限 preset。凭证来自模型厂商服务，不存入预设、工具参数或 Team 事件。模型特定的 effort 和上下文默认值仍由现有引擎／厂商配置负责；预设可提供可选且经过校验的 effort 覆盖。

模型可见的创建工具增加可选 `executionProfile`，省略时解析团队默认预设。增加 `list_execution_profiles`，返回允许的 ID、引擎、厂商、模型及相关能力。在显式启用之前不暴露任意原始参数覆盖；未知或不允许的 ID 在创建成员前报错。

```json
{
  "name": "reviewer",
  "description": "Review the implementation",
  "prompt": "Review the changed files and report concrete issues.",
  "context": "fresh",
  "executionProfile": "reviewer-claude"
}
```

创建时仅解析一次预设选择，除预设 ID 外，记录实际引擎／厂商／模型／effort／策略，后续唤醒使用该执行记录。修改预设不能静默改变已有成员。新成员使用新预设；已有成员必须显式在空闲时更新模型／厂商。

首条成员输入接纳后锁定引擎，此前允许修改草稿执行配置。空闲时可通过与主对话相同的控制器规则修改模型／厂商；厂商变化按需重启原生执行。换引擎必须新建成员 Session。

团队默认值不能从全局 UI 模型默认值隐式推断。可选 `inherit-lead` 策略在创建时对 Lead 已解析选择取快照并校验兼容性；不能静默降级到其他引擎、厂商或模型。

仍待确定的产品选择：首版是否开启显式继承 Lead 策略、高级原始参数覆盖、自动角色映射。以具名预设加显式团队默认值实现，可以暂不决定这些扩展。

<a id="lifecycle"></a>

## 成员生命周期

增加 Team 成员运行时 provider，为持久 Harness Session 实现 create／load／prepare／enqueue／interrupt／close。Team 服务负责成员关系和授权；运行时 provider 使用正常 Agent 创建路径及引擎驱动器。通过带标签的运行时描述保留历史 continuable-subagent 成员的原有运行路径。

创建顺序：校验预设与权限 → 分配稳定子 Session ID → 在 Lead 记录并刷盘 provisioning 预留 → 创建子 Session 及执行选择 → 接纳提示词前准备原生引擎 → 绑定原生身份 → 接纳初始输入 → 标记成员 active。等待 SDK 启动时不持有 Team 修改锁。失败时保留预留记录及诊断；对账可完成同一创建操作，但不能静默复用名字绑定另一 Session。

持久成员阶段与运行可用性分开：provisioning／active／failed 描述创建；running／inactive／loading／approval-pending 描述当前执行。轮次结束不意味着完成全部分配任务，空闲不等于成功。任务归属仅通过显式操作释放。

Session 唤醒：按 Team 成员关系校验调用方 → 在每 Session 加载锁下获取唯一驻留 Agent → 读取已记录执行配置及原生绑定 → 按幂等键写入持久输入 → 调度 prepare／resume 及执行。Session ID 用于定位目标，不是授权凭据。

进程不存活时：Claude 启动并恢复原生 session；Codex 使用成员私有 home 启动并恢复绑定 thread。已接纳输入对应的原生历史缺失时阻止唤醒。恢复的是对话状态并执行新一轮，不承诺从已取消 shell 命令的内部指令位置继续。

<a id="mailbox"></a>

## 邮箱与调度

将 TeamMailbox 硬编码的 steer／委派路由替换为成员输入服务。默认投递策略：空闲目标接纳并调度下一轮，忙碌目标接纳持久排队输入用于下一轮。原生 step steering 与 Codex 实时 steering 是按能力开启的可选模式。Claude 在验证锁定 SDK 的 streaming-input 时序之前默认按轮次边界投递。

使用 TeamMessageId 作为目标接纳幂等键。在 Lead 保存发送者、目标、内容及排队意图；目标持久化收据／来源后，Lead 才标记 delivered。Delivered 表示目标 Harness 持久接纳，不表示模型已消费。通过引擎输入账本单独追踪原生投递；原生投递不确定时阻止重放，要求恢复确认。

唤醒调度在启动后及每个终态轮次后处理已接纳队列，包括退出应用前已发送消息。普通 interrupt 取消当前轮次并保留队列。用户希望不自动进入下一轮时提供单独 paused 状态／操作；仅允许空闲时回收进程，且保留绑定。

Wait 观察持久／运行时进展，不阻塞 Team 修改锁。Lead 等待时仍允许成员及邮箱运行；拒绝无法产生进展的等待。任务 ready 不自动唤醒 owner，除非显式启用调度策略。增加广播时为每个接收者记录独立确认的消息。

<a id="claude"></a>

## Claude 对接

使用 `createSdkMcpServer` 和 SDK 工具定义在进程内暴露共享 Team 工具接口。通过 `mcpServers` 传入，并在模型接收之前记录实际团队策略和工具定义。每个 server 实例绑定精确成员 Agent；工具参数不能指定调用者身份或切换其他 Team。后续 Claude Lead 同样使用此路径。

通过一个共享 dispatcher 桥接现有九个 Team 工具及执行预设发现。保留 Lead-only 创建／中断限制和已有任务 revision 校验。使用原生 tool call ID 关联持久 Harness 调用／结果记录；标记桥接调用，避免原生活动观察产生重复执行或结果条目。

权限方面，纯成员／任务读取可使用显式安全允许列表。创建、中断及权限变更通过 Team 授权及配置的用户策略，不可整体自动批准 MCP namespace。普通 shell／文件授权沿用 SDK 回调。每个对话框显示成员名、引擎及 Session；中止仅使对应请求失效。

先支持 fresh 成员上下文，包含角色、初始任务及已记录团队策略。验证锁定 SDK 的 `forkSession` 行为、复制 Session 账本和独立子原生绑定后，再增加同引擎原生 fork。跨引擎上下文转移使用显式记录的上下文包，不称为原生 fork。

不能假定 SDK 会话具备 Claude CLI 原生 Agent Teams：官方文档明确 SDK／非交互会话不会创建原生 teammates。因此 Harness 管理的成员使用独立 SDK 会话。SDK 定义的内部 subagent 可作为下级原生活动展示，但没有另行设计显式接管生命周期时不视为 Team 成员。[官方 Agent Teams 文档](https://code.claude.com/docs/en/agent-teams)、[SDK 自定义工具](https://code.claude.com/docs/en/agent-sdk/custom-tools)。

<a id="codex"></a>

## Codex 对接

Team 接口优先使用 app-server 动态工具：按要求声明实验能力，创建 thread 时传入名称／描述／输入 schema，处理 `item/tool/call`，返回原生响应格式。实现前必须针对锁定的 Codex 0.153.4 验证协议支持，不能仅依赖最新文档。动态工具不可用时可选择经过认证、限定成员作用域的 MCP 桥接作为备用传输，并显式选择、展示诊断。

恢复时将持久工具集与当前接口版本比对，避免从 rollout 元数据意外恢复过期工具。Harness 日志保存公布的工具定义及版本。未知原生服务端请求返回协议错误，不能误当作授权批准。[App-server 动态工具](https://developers.openai.com/codex/app-server)。

复用 Codex 每 Session 私有 home、模型目录、凭证注入及 thread 恢复。预设可为每个成员选择不同路由／模型。仅模型变化时在签名允许的情况下复用进程；厂商／启动元数据变化时重启并恢复同一成员 thread。成员不能使用用户活跃 CLI 的 home。

可选实时消息投递通过 `turn/steer` 携带 `expectedTurnId`，RPC 前记录投递意图，成功后记录接纳。与轮次结束发生竞态时，消息回到下一轮调度，但不能重复可能已被接纳的 steer。发送后传输丢失属于不确定结果，阻止自动重试。不能通过 steer 修改模型／厂商。

可选原生 fork 在已完成轮次通过 `thread/fork` 执行。跨成员私有 home fork 需要受管理的导出／导入或受支持路径机制；公布 fork 能力前先验证，不能通过共享 SQLite／auth／config 使其工作。首版可采用 fresh／context-package。Codex 内部代理仍作为下级观察，不自动接管为持久 Harness 成员。

<a id="persistence"></a>

## 共享服务与持久化

Team 业务逻辑放在插件中：成员运行时服务、执行预设解析器、外部 Team 工具接口。共享内核仅补充与引擎无关的持久输入投递、指定配置的 Agent 创建及可选实时输入／fork 能力。不要把 Team 成员表或任务板放入 AgentLoop。

新增持久数据标明执行种类、预设 ID／版本、已解析选择、权限引用、工作目录及子 Session ID。按重建需要保存预设定义或已解析的模型可见策略。通过声明的读取兼容保留旧成员记录；确认持久化变更，更新生成 schema 及 TypeScript／Python 投影。确切事件名与格式版本由持久化评审决定，不由本提案指定。

所有模型可见团队策略、上下文包、桥接工具 schema、调用／结果、同伴输入必须能从 Session 记录重建。记录引用 ID，不记录凭证。区分用户授权工作与同伴请求；成员消息不能授予外部通信或提升权限的授权。

使用可配置的成员／进程限制、懒恢复及空闲回收。受支持的单 Harness 进程内一个 Session 只有一个运行时 owner；仍不支持跨进程 Team 写入者。持久输入触发唤醒不能依赖仅存内存的回调。现有原生存储隔离的是状态，不隔离文件修改或 endpoint 配额。

Team UI 增加引擎／厂商／模型／预设、运行／排队／加载／待授权状态、最近轮次结果及恢复错误；用户打开同一成员 Session 查看历史并继续。权限修改必须显式且受团队配置策略限制。Worktree 隔离、远程成员、嵌套团队及共享文件锁作为独立扩展。

<a id="gaps"></a>

## 引擎具备而 Harness 未承接的能力

引擎具备能力不代表锁定版本可用，也不代表第三方 endpoint 兼容。启用每项能力前核对官方协议／类型，并运行针对性 fixture。以下清单区分已知原生功能与建议的 Harness 适配。

| 引擎 | 原生功能 | 当前 Harness 缺口／建议处理 |
|---|---|---|
| Claude SDK | 程序化内部 agents：提示词、工具／模型限制。 | 目前仅配置共用模型别名；独立增加原生 agent 定义及下级 UI。 |
| Claude SDK | 进程内 MCP 工具。 | 主适配器未桥接 Team 工具；本方案增加限定作用域 server。 |
| Claude SDK | 原生 session fork；已安装类型中的后台任务开始／进度／完成及任务控制。 | 驱动器声明 fork 不支持，缺少统一后台任务生命周期；先验证锁定版本语义。 |
| Claude SDK | Hooks 与文件检查点。 | 没有 Team 生命周期映射或原子团队回滚；检查点集成独立设计。 |
| Claude CLI | 原生交互式 agent teams。 | SDK 会话不会创建原生 teammates，不能只设置 env 开关实现。 |
| Codex app-server | 动态工具及原生工具调用 RPC。 | 当前 wire 不派发 Team 工具调用；增加版本校验的桥接。 |
| Codex app-server | 实时 steer 与原生 thread fork。 | 当前驱动器均不支持；分别增加有记录的能力路径。 |
| Codex app-server | Thread read／rollback、历史注入及 review 模式。 | 缺少协调 Team 历史／回滚／审阅操作；回滚不能擦除持久同伴收据。 |
| Both | 原生内部委派／subagent。 | 不对应独立持久 Harness Team 成员；接管需要独立身份、通信及恢复设计。 |

<a id="implementation"></a>

## 实现任务与验收

| 任务包 | 归属／修改入口 | 完成条件 |
|---|---|---|
| A：预设 | `experimental/agent-team` types/config; Team settings UI; `tool-agent-team` discovery/spawn schema | 解析选择持久化；拒绝无效／歧义／禁用预设；编辑不改变已有成员。 |
| B：持久成员 | `agent-team/src/{roster,lifecycle}.ts`; proposed member-runtime provider; shared Agent construction | 创建、关闭、冷加载及唤醒同一 Session；保留旧成员并恢复 provisioning。 |
| C：邮箱 | `agent-team/src/mailbox.ts`; shared inbox/admission and engine ledger | 不强制 steer；覆盖忙碌队列、幂等收据、崩溃窗口及原生投递不确定。 |
| D：Claude 工具 | Claude `src/{engine,main-adapter}.ts`; proposed shared Team tool facade | 所有 Team 工具通过 SDK MCP 工作，具备精确调用身份、持久结果和中止。 |
| E：Codex 工具 | Codex `src/{engine,main-wire,main-adapter}.ts`; same facade | 锁定动态工具协议或显式 MCP 传输；验证恢复工具版本及错误路径。 |
| F：UI 与策略 | `experimental/client-ui-agent-team`; session-controller projections; interaction services | 混合引擎成员表、限定成员授权、空闲选择变更及可见恢复诊断。 |
| G：可选能力 | Engine capabilities + steer/fork implementations | 仅公布已验证支持；覆盖跨 home fork 及投递竞态。 |

每个任务包更新所属 README、双语设计及归属包预期。内核变化更新架构；持久 schema 变化更新子系统／持久化文档及两个 SDK 调用方。生产注册仍使用引擎 `./startup`，避免意外改变一次性委派行为。

验收矩阵：原生 Lead 下的 native／Claude／Codex 成员；桥接后的外部 Lead；相同及不同厂商／模型组合；fresh／context-package 及已验证同引擎 fork；空闲／忙碌／中止／冷恢复成员；并发授权；等待中止；配置／预设变化；未知工具；rollout 缺失；重复消息；目标收据前后崩溃；原生投递不确定。验证任务 revision 冲突和 Lead-only 授权。

先规划确定性单元与录制会话 fixture；付费真实验收作为后续明确授权步骤。使用隔离测试 home／进程及已配置兼容 endpoint，不使用用户活跃 Codex 进程。本文不执行运行时实现或测试。

## 参考

- [当前多引擎实现](../../main-agent-engines.zh.md)；[Team 服务](../../../packages/experimental/agent-team/README.zh.md)；[Team 工具](../../../packages/experimental/tool-agent-team/README.zh.md)。

- [Claude SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)；[Claude SDK 自定义工具](https://code.claude.com/docs/en/agent-sdk/custom-tools)；[Codex app-server](https://developers.openai.com/codex/app-server)。官方文档可能描述比锁定依赖更新的版本。
