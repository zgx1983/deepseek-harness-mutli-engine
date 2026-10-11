# Claude / Codex 与 Agent Team 命令支持方案

[English](engine-commands.md) | 中文

## 概述

本方案在主会话和可继续交互的 Agent Team 子会话中提供统一的 `/` 命令入口，各引擎通过自己的 SDK 或 app-server 操作执行命令。2026-10-04 实施：Claude 通过动态 `setPermissionMode` 提供 `/plan`，Codex 通过随每轮携带的原生协作模式提供 `/plan`，可继续的 Team 子会话获得仅含引擎命令的目录。2026-10-05 实施：进程级宿主权限快照与逐会话镜像。当前行为以各包公开文档为准；本文记录方案内容与版本核实结论。

## 目录

- [原始问题](#current)
- [引擎适配](#engines)
- [Agent Team 子会话](#team)
- [引擎权限配置初始化](#permission-config)
- [三个权限选项的引擎映射](#permission-mapping)
- [交付与验收](#acceptance)
- [开发备注](#notes)

<a id="current"></a>

## 原始问题

[客户端命令服务](../../../packages/client/ui-commands/src/client/service.ts) 曾对带 subagent 地址的会话返回空命令目录，导致点击 Team 成员后无法使用命令。主会话的外部引擎命令也依赖已注册的目录；缺少 `/plan` 时，输入会被拒绝。

[Claude 驱动](../../../packages/subagent/subagent-claude-code/src/engine.ts) 曾只从 SDK 获取提示命令，未接入动态权限模式切换。[Codex 驱动](../../../packages/subagent/subagent-codex/src/engine.ts) 曾提供压缩、审查和已发现的 skills，未接入规划模式切换。

<a id="engines"></a>

## 引擎适配

命令区分为提示命令、控制操作和会话生命周期操作。目录只展示当前引擎可执行的命令；控制操作无需依赖原生提示命令目录，也不作为普通消息发送。

| 操作 | Claude | Codex |
|---|---|---|
| 命令目录 | SDK `supportedCommands()`，补充适配层 `/plan` 控制命令 | 适配层注册的 app-server 操作、已发现的 skills，以及原生协作模式接口存在时的 `/plan` |
| 提示与操作 | SDK 支持的提示命令；生命周期命令单独处理 | 压缩映射到对应操作，审查映射到 `review/start`，skill 使用现有调用路径 |
| 进入规划模式 | 在活动 Query 上调用 `setPermissionMode('plan')` | 记录原生协作模式，并在其后的每个 `turn/start` 上携带 `{ mode: 'plan', settings: { model, reasoningEffort? } }` |
| 退出规划模式 | 恢复进入规划前的权限模式（委托时为 `default`） | 携带协作模式 `default` |
| 生效时间 | SDK 动态切换，影响后续权限处理 | 下一轮起生效；模式是每轮 `turn/start` 参数 |

已安装的 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk` 0.3.263）在长连接流式输入 Query 上支持 `setPermissionMode`，动态切换已对照依赖版本核实。会话期望模式以 `engine/item-settled` 的 `mode` 类别记录落日志，适配器准备时重新应用，并由共享 `plan` 投影折叠——引擎确认切换后，现有 plan 指示即可显示引擎模式。

随包发布的 Codex 0.153.4 二进制已直接核实（静态字符串加 app-server 实时探针），与 `rust-v0.153.4` GitHub tag 的 schema 不一致：二进制的 `TurnStartParams` 接受 `collaborationMode` 字段（24 字段而非 16），`collaborationMode/list` 返回 `Plan` 与 `Default` 预设，`turn/settings/update` 不携带模式。`turn/start` 将 `collaborationMode` 校验为 `{ mode, settings: { model, reasoningEffort? } }`。驱动仅在 `collaborationMode/list` 成功时注册 `/plan`，否则返回明确的不支持原因。

<a id="permission-config"></a>

## 引擎权限配置初始化

建议在 Harness 启动时读取并校验宿主的引擎权限配置，形成进程级只读快照；每个主会话或 Team 子会话启动时，将该快照应用到自己的隔离引擎目录，再结合该会话当前选择的权限预设生成最终启动参数。Codex 的 `.rules` 内容仍交给 Codex 原生运行时解析。

| 引擎 | 初始化读取 | 每会话启动时应用 |
|---|---|---|
| Claude | `~/.claude/settings.json` 的 `permissions` 段 | 写入会话使用的 `CLAUDE_CONFIG_DIR/settings.json`；按所选权限策略决定保留或清除；项目和本地设置仍由原生来源加载 |
| Codex | `~/.codex/config.toml` 中支持的权限字段，以及 `~/.codex/rules/*.rules` | 将配置字段和规则文件镜像到该会话的 `CODEX_HOME`；规则解析由 Codex 完成 |

进程级快照只固定原生配置。`/permission` 的选择和推导出的引擎参数仍按会话计算，因此不同会话可以选择不同级别。宿主配置在 Harness 运行期间保持快照语义：外部文件修改在 Harness 重启后生效。本方案不包含运行时刷新全局快照。

已按方案实现：引擎注册时读取并校验宿主配置形成进程级快照——Claude 快照 `~/.claude/settings.json` 的 `permissions` 段；Codex 快照 `config.toml` 支持的权限字段，并原文快照每个 `rules/*.rules` 文件，规则解析仍交给 Codex 原生运行时。每次会话准备把快照应用到自己的引擎目录——Claude 写入 `CLAUDE_CONFIG_DIR/settings.json`，完全权限时清除；Codex 把配置字段和规则文件镜像进 `CODEX_HOME`，完全权限时移除。宿主文件修改在 Harness 重启后才进入快照。

<a id="team"></a>

## Agent Team 子会话

点击成员后沿用现有子会话导航和输入组件。可继续交互的成员获取自己的命令目录，按成员引擎展示候选项；一次性子任务和不可恢复的会话保持空目录。

命令请求携带当前子会话 ID，通过[会话命令控制器](../../../packages/api/session-controller/src/commands.ts)已有的子智能体生命周期管理取得对应引擎实例。规划、压缩、审查和 skill 操作只作用于该成员，不回退到 Lead。父会话必须满足现有借用与恢复条件。子会话目录只含引擎命令；`/model` 等 Host 注册表命令仍是主会话命令。

模式、命令目录缓存及确认状态按子会话独立维护。切换成员、恢复引擎或收到目录变更时，更新对应目录。打开成员会话不自动发送提示；命令查询如需准备引擎，遵循现有生命周期。关闭、失联、恢复失败或不支持的操作返回明确原因。

<a id="permission-mapping"></a>

## 三个权限选项的引擎映射

权限选择器继续表达三个用户可理解的级别。引擎启动时把当前会话所选级别映射成 Claude 或 Codex 原生参数；工作区修改采用各引擎的权限配置，完全权限明确解除常规沙箱和审批限制。

| 选择项 | Claude 启动映射 | Codex 启动映射 |
|---|---|---|
| 只查看 | 启用只读沙箱并限制文件写入；其他需要权限的工具请求进入 DSH 审批，只有原生引擎能执行获批的临时授权时才放行 | `sandbox: 'read-only'`、`approvalPolicy: 'on-request'`；其他需要权限的操作进入 Codex 审批，获批后按原生协议提供临时权限 |
| 工作区修改 | 保留 Claude `settings.json` 中的原生权限规则，加载用户、项目和本地设置；不以 DSH 默认值覆盖这些规则 | 保留 Codex `config.toml` 权限字段及 `rules/*.rules`；不以 DSH 默认值覆盖原生配置 |
| 完全权限 | `permissionMode: 'bypassPermissions'`，关闭 Harness 配置的沙箱和常规审批；清理镜像进隔离目录的宿主权限规则 | `sandbox: 'danger-full-access'`、`approvalPolicy: 'never'`；不应用宿主配置中的权限覆盖 |

只查看仍受引擎原生拒绝规则和操作系统沙箱限制；DSH 的审批批准不能推翻原生 deny。完全权限映射的实际覆盖范围也要遵循各引擎的原生硬性拒绝规则，验收时需分别确认，不能只根据模式名称推断。

**本阶段包含已运行会话的权限切换。** 对话框权限下拉菜单和用户输入 `/permission <预设>` 都调用同一个 Harness 命令，更新当前 Session 的权限预设。若该级别改变了引擎启动参数，当前轮次先完成；Harness 在下一轮准备时重启该会话的引擎、恢复同一原生对话，再以新参数启动。Claude 通过新 Query 应用新模式与沙箱；Codex 通过恢复线程时的 sandbox 和 approval 参数应用新权限。新权限从重启后的下一轮生效。

本阶段不包含活跃轮次中途改变权限，也不包含运行时刷新进程级宿主配置快照。`/permission` 只改变会话所选级别，不重读宿主文件；外部修改 Claude `settings.json` 或 Codex `config.toml`、`rules/*.rules` 后，重启 Harness 才会进入新的全局快照。

<a id="acceptance"></a>

## 交付与验收

实施顺序为：核实两种引擎的原生权限行为，初始化进程级配置快照并镜像到会话目录，按三种权限级别生成引擎启动参数，接通下拉菜单与 `/permission` 的会话更新和下一轮重启恢复，再补充功能检查清单。

- 覆盖主会话／Team 子会话与 Claude／Codex 的组合，验证目录、命令执行及不支持的命令提示。
- 验证运行中选择新权限后，当前轮次完成、目标引擎重启、原生会话恢复且新级别在后续轮次生效；其他 Session 不受影响。
- 验证命令作用于指定成员，Lead 和其他成员不受影响；成员切换后目录和状态不串用。
- 验证宿主权限文件在 Harness 重启后进入新快照；`/permission` 不意外刷新全局配置，失败或不支持的原生权限配置明确报错。
- 验证关闭会话、不可恢复成员、父会话不可用和一次性子任务的失败提示。
- 验证压缩、审查及带参数的提示或 skill 调用。无密钥录制的会话快照不受影响：没有 SessionEventMap 成员变化。
- 模式状态通过 `engine/item-settled` 的 `mode` 类别可从会话日志重建；没有声明的持久化类型变化，`plan` 投影提升状态版本以从日志重建缓存。

<a id="notes"></a>

## 开发备注

2026-10-04 实施，权限快照初始化与镜像于 2026-10-05 补齐。上文的 Codex 结论来自随包发布的 0.153.4 二进制而非 GitHub tag；固定 Codex 版本变化时须重新对照二进制核实。
