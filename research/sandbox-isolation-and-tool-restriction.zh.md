# deepseek-harness 沙箱隔离与工具管控机制调研报告

面向二次开发的机制调研：① 沙箱与会话隔离如何实现；② 工具如何注册、暴露，以及现有全部白名单/权限控制点。所有结论均给出代码证据（`文件:行号`，以 `migrate-main-engines` 分支 2026-10-05 工作树为准）。报告不修改任何产品代码。

## 目录

- [1. 总体架构：两条主线如何咬合](#1)
- [2. 沙箱机制](#2)
- [3. 工具体系与白名单/权限控制](#3)
- [4. 二次开发建议：构建"只能用指定工具"的智能体系统](#4)
- [5. 关键文件索引](#5)

<a id="1"></a>

## 1. 总体架构：两条主线如何咬合

deepseek-harness 是全插件化的 Cordis 智能体框架。所有能力以"能力接缝（capability seam）"挂在 `ctx` 上（`ctx.shell`、`ctx.sandbox`、`ctx.tools`、`ctx.approval`、`ctx.fs` 等），插件通过 effect 注册贡献，注销即卸载。沙箱与工具管控分别由两条链路承担，并在执行点汇合：

```
用户/客户端 ──► Session（会话日志：sandbox/mode、approval/policy、permission/preset、tool/result…）
                     │ 投影折叠（sessionProjections）
                     ▼
模型请求 ◄── systemPrompt 组装（工具 schema=可见性过滤后的白名单视图）──► LLM
   │ 模型发出 tool_call
   ▼
Agent Loop（agent-loop）──► ToolRuntime 执行管线（core/tools）
   prepare → tools/pre-execute 瀑布(allow/deny/cancel/ask) → 审批(ask) → 单调 guards
   → tools/execute → 工具体 → tools/post-execute → tool/result 落日志
   │ bash 类工具
   ▼
ctx.shell（执行接缝，携带每次调用的 SandboxPolicy）
   │ resolve(request)
   ▼
bash-sandbox ── danger-full-access 直通；其余 ──► ctx.sandbox.confine(argv)
   ▼
sandbox-local 平台链：macOS seatbelt / Linux bwrap→landlock / Windows ACL restricted token
   ▼
ctx.subprocess.spawn（托管进程域 + 环境变量清洗 + 树级终止）

外部引擎（Claude / Codex）平行存在：DSH 权限预设映射为引擎原生参数
（SDK Options.sandbox / canUseTool；thread sandbox + approvalPolicy），
引擎进程同样经 ctx.subprocess.spawn 托管。
```

四条贯穿性设计原则，二次开发时应沿用：

1. **会话策略状态只存在于会话日志**。沙箱模式、审批策略、权限预设都是 log-only 事件（`sandbox/mode`、`approval/policy`、`permission/preset`），由投影单元折叠出当前值，可重放、可审计（`packages/sandbox/sandbox-policy/src/session-mode.ts:33-55`、`packages/interaction/permission-presets/src/index.ts:134-150`）。
2. **可见性 = 执行权**。工具对模型不可见就不可执行，两个入口共用同一份过滤视图，不存在"看不见但能调"的旁路（`packages/core/tools/src/index.ts:1248-1253`）。
3. **失败即关闭（fail closed）**。沙箱后端不可用抛 `SANDBOX_UNAVAILABLE` 拒绝裸跑；审批应答者缺失/抛错按 `unavailable` 拒绝；配置错误在装载期报错。
4. **授权只有一种：`allowed-once`**。审批的唯一放行结果是单次授权，无"永久放行"状态。

<a id="2"></a>

## 2. 沙箱机制

### 2.1 沙箱模式与每会话策略状态

`sandbox` 包组共四个包（`packages/sandbox/README.md:23-31`）：`sandbox`（接缝与词汇）、`sandbox-local`（本机 provider）、`sandbox-policy`(策略解析)、`sandbox-windows-acl`（Windows 限制令牌 runner）；另有包组外的 `packages/ssh/sandbox-ssh` 远程后端。

- 模式词汇：`SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']`（`sandbox-policy/src/session-mode.ts:42`，类型定义在 `sandbox/src/index.ts:30`）。**模式只约束文件副作用，完全不约束网络**（`packages/sandbox/sandbox/src/index.ts:24-30`、`docs/subsystems/sandbox.md:14`）。
- 每会话覆盖写日志：`setSandboxMode(session, mode)` 追加一条 `sandbox/mode` 事件（`session-mode.ts:53-55`）；`SandboxPolicyService` 注册 `sandboxMode` 投影折叠该事件（`sandbox-policy/src/index.ts:133-139`）。
- 执行时解析（`sandbox-policy/src/index.ts:164-171`）：`mode = 已批准的显式覆盖 ?? 会话最后一条 sandbox/mode ?? 部署默认`；`workspaceRoot = 会话 cwd（绝对路径）?? 配置根（默认 process.cwd()）`。包 schema 默认 `read-only`（`index.ts:113`），但出厂 `dsh-base` bundle 覆盖为 `DSH_PERMISSION_MODE ?? 'workspace-write'`（`packages/bundle/base/cordis.patch.yml:232-234`）。
- 当前策略还会渲染进系统提示（`sandbox:policy` 上下文，`index.ts:141-152`），模型能看见自己所处的模式。

### 2.2 一次 bash 调用的完整执行链

`packages/shell/` 包组分工：`shell`（接缝）、`bash-local`/`pwsh-local`（不隔离执行器）、`bash-sandbox`/`pwsh-sandbox`（隔离执行器）、`tool-bash`/`tool-pwsh`（模型工具）、`shell-env`（受管 `DSH_*` 环境注册表）。

1. **工具层** `tool-bash/src/index.ts:480-529`：每次调用先 `sandboxPolicy.resolve({session})`（`:222-223`）；若模型请求 `sandbox_permissions` 升级，先经 `approveEscalation` 走审批（`:236-256`，升级目标仅限相邻更宽模式，`sandbox/src/escalation.ts:28-41,171-208`）；然后构造携带策略的 `ShellExecRequest`，调 `ctx.shell.execute(ctx.shell.resolve(request))`（`:526`）。前台调用注册为可 kill 的 job，超时可转后台（`:516-524`）。
2. **执行器层** `bash-sandbox/src/index.ts:45-190`：`danger-full-access` 直接本地执行并在结果上标注 `sandbox:{mode, denied:false}`（`:92-97`）；其余模式把原 argv（`['bash','-c', command]`）交给 `ctx.sandbox.confine(...)` 包裹后再 spawn（`:187-189`）。
3. **进程层** `bash-local/src/index.ts:97-404`：经 `ctx.subprocess.spawn()` 启动（`:259`），执行器超时与调用方取消融合为单一信号（`:210-249`），输出上限/溢出落盘、优雅终止分层。

结果携带 `ShellSandboxInfo { mode, denied, enforcement, runnerFailed }`（`shell/src/types.ts:35-44`），隔离事实进入会话事件，可审计。

### 2.3 各操作系统的具体实现

provider 按平台链选择 runner（`sandbox-local/src/index.ts:160-167`）：`linux: ['bwrap','landlock']`（bwrap 优先，功能探测仲裁）、`darwin: ['seatbelt']`（唯一候选，不探测）、`win32: ['windows-acl']`（唯一候选，不探测）。探测失败即整条链不可用。

| 平台 | 机制 | 配置原文（`sandbox-local/src/profiles.ts`） | 要点 |
|---|---|---|---|
| macOS | **Seatbelt**（`sandbox-exec -p` + SBPL） | `(allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))`；workspace-write 追加 `(allow file-write* (subpath <workspace>) (subpath /tmp) (subpath <tmpdir>))`（`:51-58`） | 默认允许、拒绝写，写白名单=可写根；Apple 已弃用该 CLI 但仍随系统发布；缺失时探测失败→fail closed |
| Linux | **bubblewrap**（挂载命名空间） | `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`；workspace-write 追加 `--tmpfs /tmp --bind <workspace> <workspace>`（`:16-23`） | `--unshare-pid` 附加限制进程可见性；只读模式=全根只读 |
| Linux 备选 | **Landlock**（内核 LSM，原生 launcher） | `--ro /` + `--rw /dev/null`（workspace-write 追加 `--rw /tmp <workspace>`）（`:30-36`） | launcher 来自 `native/landlock-run` 预编译二进制，**禁止环境变量指定二进制**（"由哪个二进制 confinement 进程绝不能由环境决定"，`native/landlock-run/packages/entry/lib/index.js:12-14`）；失败契约 exit 125；探测区分完整/旧 ABI 部分执行 |
| Windows | **受限令牌 + 派生能力 SID** | `CreateRestrictedToken`（koffi FFI，`sandbox-windows-acl/src/token.ts:17-36`）+ 每 workspace 哈希出写 SID、每会话随机私有临时目录与私有 SID（`src/workspace-sid.ts`、`sandbox-local/src/index.ts:369-488`） | 以 `CreateProcessAsUserW` 在受限令牌下启动；runner 侧任何失败打印 `windows-acl-run:` 并 exit 127，**绝不以完整令牌放行子进程**（`src/runner.ts:5-43`）；enforcement 报 `partial`（NTFS 硬链接可别名、读不受限） |

可写根统一计算：`writableRoots() = 规范化的 workspace 根 + /tmp + os.tmpdir()`（`sandbox/src/roots.ts:30-55`），Seatbelt profile 与进程内文件围栏共用，保证两处永不漂移。

### 2.4 fail-closed 语义与失败分类

- **不可用即拒绝**：无可用后端时 `confine()` 抛 `SandboxUnavailableError`（code `SANDBOX_UNAVAILABLE`），"拒绝以未隔离方式运行命令"（`sandbox/src/index.ts:125-145`）。
- **runner 故障 ≠ 策略拒绝**：按结构化签名区分（`sandbox/src/diagnostics.ts:33-87`；各 runner 致命签名如 `bwrap: `、`sandbox-exec: `、landlock exit-125、windows-acl exit-127）。前台调用遇 runner 故障直接抛错（命令未执行，`bash-sandbox/src/index.ts:120-130`）；后台进程在 `proc.sandbox` 标 `runnerFailed`（`:158-176`）。
- **拒绝可辨识**：按后端方言分类拒绝签名（bwrap=EROFS、Landlock="permission denied"、Seatbelt="operation not permitted"，`sandbox-local/src/index.ts:207-215`），并向模型返回 `[sandbox: file access denied under <mode> mode]` 与升级提示标记（`sandbox/src/escalation.ts:71-86`）。
- **升级审批**：`approveEscalation` 只放行相邻更宽模式、必须存在审批服务与归属 agent、结果仅 `allowed-once`（`escalation.ts:171-208`）。bash 与 fs 工具族共用。
- **进程内文件围栏** `fs-sandbox`（`packages/fs/fs-sandbox/src/index.ts:1-70`）：在可信代码中对模型控制路径做 canonicalize-then-contain 检查，注册为 `ctx.fs`；文档明言这是"containment, not a security boundary"，内核级隔离由 `ctx.shell` 承担。

### 2.5 进程缝合与环境隔离（subprocess）

- **托管进程域**：每个 spawn 选择 containment 模式——Linux 用户级 systemd scope（`linux-scope.ts`）、Windows 私有 Job Object（`windows-job.ts`）、其余平台回退进程组并一次性告警（`subprocess-local/src/index.ts:182-251`）。终止分层：SIGTERM 整域 → `graceMs`（默认 3s）→ SIGKILL；Windows `taskkill /T /F` 立即整树（`spawn.ts:352-368`）。服务销毁时终止并等待全部托管进程（`subprocess/src/index.ts:109-110`）。
- **环境变量清洗**：`scrubbedParentEnv()` = 父环境 −（匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的名字）−（全部 `DSH_*`，大小写不敏感）；`PATH/HOME/locale/代理`保留（`subprocess/src/index.ts:40-80`）。这是所有 harness 子进程的规范基底；引擎凭据（如 `ANTHROPIC_API_KEY`）只能经引擎 owned env 注入，且部署配置**禁止覆盖**保留键（`subagent-claude-code/src/engine.ts:523-525`、`subagent-codex/src/engine.ts:500-505`）。
- **可执行文件解析**：绝对路径 `stat+X_OK` 校验；裸名在清洗后的 `PATH` 上解析；含分隔符的相对路径直接拒绝（"解析基底未定义"，`subprocess-local/src/index.ts:140-180`）。

### 2.6 引擎会话隔离（Claude / Codex）

外部引擎进程不接触宿主真实配置目录，凭据与状态隔离：

- **Claude**：以 `$DSH_HOME/engines/claude`（0700，profile 级）作为 `CLAUDE_CONFIG_DIR`（`subagent-claude-code/src/engine.ts:494-497,518-522`）。会话隔离靠持久化的 native session id 绑定（`engine/item-settled` category `binding` 事件，重放时校验 cwd，`core/agent/src/engine-records.ts:43-72`）。从宿主 `~/.claude` 只镜像三样东西：`CLAUDE.md`、skills 目录、`settings.json` 的 `permissions` 段（权限段按进程快照读一次，每会话应用，`engine.ts:499-507`、`user-memory.ts:41-83`）；凭据、其余设置字段、会话历史一律不镜像。完全权限会话会清除镜像的权限规则，防其经 settings 复权（`engine.ts:503-505`）。
- **Codex**：每会话独立 home `<home>/engines/codex/session-homes/<sha256(sessionId)>`（0700，`subagent-codex/src/storage.ts:63-101`），配独立 `CODEX_SQLITE_HOME` 与日志目录。恢复时在会话 home 内查找 `*-<nativeId>.jsonl` 并**校验**其 `session_meta`（id 与 cwd 必须匹配、不得多义，`storage.ts:33-43,78`）；旧版共享存储只迁入匹配的 rollout 文件（临时文件+排他创建+硬链接+0600，`:89-99`）。宿主 `~/.codex` 只镜像权限/信任/项目文档字段与 `rules/*.rules`（进程级快照，重启发条），模型/提供者/MCP/凭据字段永不进入会话 home（`user-config.ts:104-134`）；完全权限会话剥离权限字段与规则（`withoutNativePermissions`，`:260-268`）。

### 2.7 人工在环：审批与提问

- `ctx.approval`（`packages/interaction/user-approval`）：策略 `ask | never`，每会话覆盖以 `approval/policy` 事件持久化。**`never` 在服务内部、任何瀑布 listener 之前确定性拒绝**（`user-approval/src/index.ts:269-277`，注释明确防止事后 `prepend` 的 listener 绕过）；`ask` 派发 `approval/request` 瀑布，无应答者/应答者抛错/非法返回一律 fail closed 为 `unavailable`（`:282-294`）。每次审批落 `approval/asked` + `approval/decided` 审计事件对，且必须被包含在一个开启的 turn 内（`:84-92,214-236`）；abort 即 `cancelled`，迟到应答被丢弃。
- 审批/提问随所属轮次过期：引擎把轮次信号与原生回调信号 `AbortSignal.any` 融合（Claude `engine.ts:563-565`、Codex `:553`）。
- `ctx.userQuestions`（交互提问）与 `permission-presets`（`/permission` 命令捆绑"沙箱模式 × 审批策略"两个旋钮，`permission-presets/src/index.ts:416-431`）构成用户可感知的权限面。

### 2.8 边界与已知限制（二次开发必须知晓）

1. **同主机、同内核**：沙箱是"同世界"的 argv 包裹（`sandbox/src/index.ts:2-4`），非容器/微虚拟机。要更硬的隔离需整体替换 seam（`sandbox-ssh` 远程后端或自接容器运行时）。
2. **网络不受沙箱模式管理**：三种模式只管文件写。需要网络限制必须另行实现（防火墙/代理/引擎层）。
3. **Windows enforcement=partial**：硬链接别名、读不受限、AppContainer 树不可读（`sandbox-local/src/index.ts:178-189`）。
4. **macOS `sandbox-exec` 已被 Apple 弃用**：当前仍可用，但长期依赖需关注。
5. **fs-sandbox 是进程内围栏**，不是安全边界；真正的安全边界是内核级 argv 包裹。
6. 引擎沙箱依赖各引擎原生实现（Claude SDK sandbox、Codex 原生沙箱），其覆盖范围以引擎为准，DSH 只能映射参数不能增强（方案文档也明确"DSH 的审批批准不能推翻原生 deny"）。
7. **会话间文件副作用不做隔离**：workspace-write 的可写根包含全机共享的 `/tmp` 与 `os.tmpdir()`，并发会话可互相读写对方的临时文件；read-only 会话虽不可写但可读面不受限。详见 §5.1 专题分析。

<a id="3"></a>

## 3. 工具体系与白名单/权限控制

### 3.1 工具注册与模型可见性

- 工具注册表是 `ctx.tools`（`@deepseek-ai/dsh-tools` = `packages/core/tools`）。插件经 `tools.register(definition)` 注册（registrations-as-effects，返回精确 disposer；重名失败、`run_code` 保留，`core/tools/src/index.ts:1064-1089`）。工具定义 = `name/description/parameters` + `execute(args, exec)` + 输出 schema/渲染（`:223-299`；创作助手 `defineTool` 在 `schema.ts:554-632`，自动做参数校验）。
- **模型可见清单的组装**：注册表把 schema provider 挂进 systemPrompt（`:855`）；每次请求由 `systemPrompt.assemble` 收集并按 `toolOrder` 排序（`core/system-prompt/src/index.ts:521-622`），最终进入 LLM 请求的 `tools` 参数（`core/agent-loop/src/agent.ts:350,592,769-780`）。作用域层（`ScopedLayers`）支持每 agent 覆盖全局（`:834-837`）。
- 内置工具约 40 个，分布在 `packages/fs`（read/write/edit/glob/grep…）、`packages/shell`（bash/pwsh）、`packages/web`（web_search/web_fetch）、`packages/todo`、`packages/plan`、`packages/goal`、`packages/skill`、`packages/terminal`、`packages/jobs`、`packages/lsp`、`packages/workflow`、`packages/subagent`（subagent/send_message/interrupt_agent）、`packages/experimental/tool-agent-team`（团队工具）、`packages/mcp`（`mcp__<server>__<tool>`）等。

### 3.2 执行管线与三个拦截点

模型 tool_call 的执行管线（`core/tools/src/index.ts`）：

```
prepareExecution (1494)
  ├─ PTC 折叠预检（ptc 模式下模型直调普通工具 → UNKNOWN_TOOL，1401-1475）
  ├─ 取消检查
  ├─ tools/pre-execute 瀑布 → PreToolDecision = allow | deny | cancel | ask (1505-1536)
  │    └─ ask → ctx.approval.request（唯一放行 allowed-once，1728-1769）
  ├─ 单调 ToolGuard（deny-only，在瀑布后、工具体前，1520）
dispatchScheduledExecution (1602) → tools/execute 环绕瀑布 → 工具体
finalize/finish → tools/post-execute（accept/block，1782-1821）→ tool/result 落日志
```

因此白名单有三个不同时机的挂点：**(a) 可见性**（restrict，模式发出前就看不到）、**(b) 派发前**（pre-execute 监听 + guard，可按参数拒绝）、**(c) 结果后**（post-execute block）。三者叠加，且 (a) 同时约束 prompt schema 与 dispatch（`view(scope)` `:1179-1220`；不可见工具派发时报 `UNKNOWN_TOOL`，`:511-527,1580`）。

### 3.3 `tools.restrict` —— 一等公民的白名单原语

```ts
// packages/core/tools/src/index.ts:701-706, 1098-1125
tools.restrict({ allow: ['read', 'grep', 'bash'] })   // 白名单：只留这些
tools.restrict({ deny: ['write', 'web_search'] })     // 黑名单：精确按名剔除
```

语义要点（实现 `:1098-1125`、视图 `:1179-1220`）：

- **只允许在 agent 作用域上下文调用**：全局上下文调用直接抛错（"全局限制会遮住每个 agent"）——设计上强制白名单必须面向具体 agent。
- **跨作用域链求交集**：父子 scope 的限制取交集，只会更严；且**不影响 scope 自己注册的工具**（委派场景父级无法削掉子级自带工具，只能削全局工具）。
- **fail loud**：空过滤器抛错（"几乎总是配置物化为空的 bug"）；引用未知工具名抛错并列出已知名；不能命名保留的 `run_code`。
- **可见性=执行**：被限制的工具同时从 prompt schema 与 dispatch 消失，模型尝试调用得到 `UNKNOWN_TOOL`。
- `restrict()` 返回精确 disposer——**白名单可以编程式动态解除/重设**，这是做"运行时按用户调整工具面"的钥匙。

### 3.4 其余管控机制（全景）

| 机制 | 执行点 | 粒度 | 证据 |
|---|---|---|---|
| `tools.guard()`（单调 deny-only） | pre-execute 后、工具体前；无 allow 结果，监听顺序无法把拒绝翻成放行 | 全局或每 agent | `core/tools/src/index.ts:725-745,1137-1155,1520`；实例：结构化输出收尾 guard（`subagent-in-process-driver/src/structured.ts:109-111`） |
| `tools/pre-execute` 瀑布 | 每次调用 allow/deny/cancel/ask | 每调用 | `core/tools/src/index.ts:1505-1536`；实例：Auto review 风险分级 gate（`experimental/auto-review/src/index.ts:686-721`） |
| 审批服务 | `ask` 决策 → `allowed-once` 才放行；`never` 在服务内先决 | 每调用 × 每会话策略 | `interaction/user-approval/src/index.ts:217-309` |
| 权限预设 `/permission` | 写 `permission/preset` + 两旋钮事件；执行层生效 | 每会话 | `interaction/permission-presets/src/index.ts:416-431` |
| 沙箱模式 | 执行器逐调用 resolve；文件副作用 | 每会话 | 见 §2 |
| **Agent Preset 组合** | preset = 一组插件行；**装哪些工具插件决定工具面**；首条用户消息后锁定，创建后不可换 | 每 preset（作用域内所有 agent）；会话创建时经 `agentPreset` 选择 | `preset/agent-preset/src/index.ts:12-30`、`agent-preset-registry/src/index.ts:257-334`、`api/session-controller/src/agent.ts:423-439` |
| 子代理委派固定 | `toolFilter` → 子 scope `tools.restrict`；approval 钉死 `never`；策略在创建时定格 | 每子 agent | `subagent/subagent/src/child-agent.ts:172,213-226,257-264`、`types.ts:193-200` |
| PTC 表现模式 | `ptc` 模式下模型只能见/调 `run_code`，直调普通工具被拒 | 每 scope | `core/tools/src/index.ts:1352-1354,1401-1475` |
| Skills 调用策略 | 每技能 `modelInvocable/userInvocable`；`skill` 工具每次调用复检；目录同步过滤 | 每技能 | `skill/skill/src/index.ts:126-136`、`tool-skill/src/index.ts:138-147`、`api/session-controller/src/skill-catalog.ts:77-84` |
| 引擎侧白名单（Claude） | read-only → SDK `tools:['Read','Glob','Grep','AskUserQuestion']` + `canUseTool` 兜底拒绝；`allowedTools: ['mcp__dsh_team__*']`；一次性子代理 `disallowedTools` + deny-all canUseTool；宿主权限规则镜像（bypass 清除） | 每引擎会话 | `subagent-claude-code/src/engine.ts:533,542,562-601`、`run.ts:331-354` |
| 引擎侧审批（Codex） | 会话策略映射 `approval_policy/sandbox_mode`；宿主 rules 镜像；团队 MCP `default_tools_approval_mode="approve"` | 每引擎会话 | `subagent-codex/src/engine.ts:444-448,498-523` |
| MCP 命名与冲突回滚 | `mcp__<server>__<tool>` 确定性命名；注册冲突整代回滚（防命名抢注） | 每 MCP server | `mcp/mcp-client/src/tools.ts:81-87,148-160` |
| 超时与循环防护 | `timeoutMs` 融合截止；重复调用提醒（仅提示不拦截） | 每工具/每 agent | `guard/timeout-policy`、`guard/repeat-tool-reminder` |

**明确不存在的能力**（二次开发需自建）：

1. **没有用户/角色/租户身份体系**。全链路无 principal 概念；身份仅是遥测用匿名 UUID（`identity/anonymous-user-id`）。settings 的"user 层"指本地配置文件层，非多用户。所有策略状态都是 per-session / per-scope，不是 per-principal。
2. **mcp-client 无 per-tool 允许清单配置**。MCP 工具过滤只能靠通用机制（restrict/组合装载）。
3. **没有声明式的"会话工具白名单"配置行**——但组合（preset）+ `restrict` 两板足以拼出。

### 3.5 与外部引擎的边界（极易混淆，重点）

`ctx.tools` 注册的是 **DSH 原生工具**（bash、read、web_search…）。当会话选择外部引擎（Claude/Codex）时，模型实际使用的是**引擎自己的工具集**（Read/Bash/WebSearch…），它们不经过 `ctx.tools`。因此：

- `tools.restrict` 管不到 Claude/Codex 的内部工具；
- 引擎侧白名单要用引擎机制：Claude 经 SDK Options（`tools` 白名单、`allowedTools`、`disallowedTools`、`canUseTool` 回调）+ 镜像的宿主权限规则；Codex 经原生 `approval_policy`/`sandbox_mode`/rules 镜像；
- 两套白名单**必须同时配置**才能端到端收紧。DSH 对引擎的约束力止于启动参数映射与审批路由（canUseTool/onRequest → `ctx.approval`）。

<a id="4"></a>

## 4. 二次开发建议：构建"只能用指定工具"的智能体系统

### 4.1 推荐的五层管控模型（由粗到细）

| 层 | 手段 | 效果 | 建议 |
|---|---|---|---|
| L0 组合 | 自定义 Agent Preset：只装载需要的工具插件 | **未注册即不存在**——最可靠的白名单，零旁路 | 面向"用户组"定义 preset（如只读分析型、编码型、运维型），这是第一道也是最强的闸门 |
| L1 可见性 | agent scope 内 `tools.restrict({ allow: [...] })` | 细粒度、可动态（保存 disposer 可编程调整） | 在 agent 创建 setup 中统一执行；以 allow 白名单为准（默认拒绝），不用 deny 反向枚举 |
| L2 会话策略 | 权限预设（沙箱模式 × 审批策略）；服务端创建会话时钉死，禁用 `/permission` 的放宽方向 | 限制副作用与放行通道 | 面向最终用户的部署建议默认 `read-only`/`workspace-write + ask`；`never` 审批仅用于全托管场景 |
| L3 单调用 | `tools.guard` / `tools/pre-execute` 做参数级校验、限流、审计 | 拦截"工具允许但参数越界"（如 bash 白名单命令前缀校验） | guard 单调 deny-only，适合硬策略；pre-execute 的 `ask` 适合"高风险参数升级审批" |
| L4 引擎侧 | Claude `tools/allowedTools/canUseTool`；Codex 宿主权限镜像 | 补齐外部引擎内部工具的管控 | DSH 层 restrict 对引擎工具无效，务必双写（见 §3.5） |

### 4.2 "最终用户"维度的落地路径

现状没有 principal 体系，推荐按以下顺序落地（改造成本从低到高）：

1. **用户组 → Preset 映射**：服务端在 `session.create` 时按用户身份选 `agentPreset`（`SessionCreateRequest.agentPreset`）。这是纯组合层实现，不改核心；配合 API 网关按用户限制可用 preset 列表即可。
2. **动态白名单**：利用 `restrict()` 返回的 disposer，在 `ctx.agents` 侧保存每个 agent 的当前限制；做一个小的"策略服务"插件，按用户/会话读取白名单配置，在 agent setup 时 `restrict({allow})`，需要时 lift + 重新 restrict。注意约束：restrict 是交集语义、只能削全局工具，重设需谨慎排序。
3. **策略判定点**：若需要每次调用实时判定（如对接外部权限系统），实现一个全局 `tools.guard`，从 `execution` 里取 `agent.session`（可拿到创建者元数据——需自行在 `session.create` 时把用户身份写进会话 meta/事件），deny 时返回原因。
4. **审计闭环**：现成日志已覆盖 `approval/asked|decided`、`permission/preset`、`sandbox/mode`、`tool/result`，加一个 `tools/pre-execute` 监听即可补齐"每次工具调用的策略判定记录"，满足审计需求。

### 4.3 安全检查清单

- [ ] 默认拒绝：preset 不装载未批准的工具插件；setup 中显式 `restrict({allow})`，不依赖 deny 枚举。
- [ ] 保留 fail-closed：不把 `bash-sandbox` 换成 `bash-local`；部署默认沙箱模式不用 `danger-full-access`；`sandbox-local` 的 runner 探测与 `failIfUnavailable` 保持开启。
- [ ] 明知网络不受沙箱管：有网络合规要求时在引擎层（如禁用 web 工具）或网络层（代理/防火墙）另行限制。
- [ ] 引擎双写白名单：选 Claude/Codex 引擎的会话，必须同时配置引擎侧机制（§3.5），并确认"DSH 审批不能推翻引擎原生 deny"的预期。
- [ ] MCP 工具纳入白名单管理：`mcp__<server>__<tool>` 名字进 allow 表；只挂可信的 MCP server 插件行。
- [ ] 审批通道唯一化：最终用户产品建议 `approval` 走 web UI 应答器；关闭 ACP 等其他应答通道，避免旁路。
- [ ] 环境变量清洗（scrub）不是权限边界：敏感数据交给凭据服务（`ctx.credentials`）而不是环境变量。
- [ ] 会话策略事件是权威：任何 UI 上的"权限显示"应读投影（`sandboxMode`/`approval`/`permissions`），不要自建状态。
- [ ] **会话间文件隔离**：并发会话的临时文件写入使用会话私有目录（见 §5.1）；多租户部署评估同 UID 读暴露面，必要时低权用户/容器化。
- [ ] **bash 命令策略**：白名单含 bash/pwsh/terminal/run_code 时，必须有命令前缀白名单 guard 或引擎 execpolicy（见 §5.2），并禁止嵌套 agent CLI。
- [ ] 若需硬隔离（不可信代码执行）：在 seam 层替换——接 `sandbox-ssh` 远程执行或容器/microVM provider，而不是在应用层堆补丁。

### 4.4 一个最小可行组合（示例形态）

面向"只能用 read/grep/bash(只读沙箱) 的最终用户"：

```
1. 自定义 preset "analyst-readonly"：插件行只含 tool-fs(read/read_image)、
   tool-fs-search(glob/grep)、tool-bash、bash-sandbox、sandbox-local、
   sandbox-policy(read-only)、user-approval(ask)。
2. 服务端 session.create({ agentPreset: 'analyst-readonly' })，按用户组选择。
3. agent setup 中 tools.restrict({ allow: ['read','read_image','glob','grep','bash'] })。
4. 引擎选择为 claude 时：启动映射已在 read-only 档
   （SDK sandbox enabled + allowWrite [] + tools 白名单），无需额外配置。
5. 可选：guard 校验 bash 命令前缀白名单；webhook/审计监听记录每次调用。
```

<a id="5"></a>

## 5. 安全专题补充（2026-10-05）：跨会话文件隔离与 bash 逃逸

针对二次开发最常被追问的两个安全问题做专项核查：**不同会话的文件读写是否隔离（尤其 /tmp）**、**未注册工具能否经 bash 运行**。结论：两个方向现有机制都不完整，需要补充设计。

### 5.1 专题一：跨会话文件读写隔离（/tmp 共享问题）

**结论：DSH 的会话隔离不包含"文件系统副作用按会话隔离"。**

隔离了什么：会话策略状态（日志事件）、审批通道、引擎配置目录（Claude profile 级 / Codex 每会话哈希 home，见 §2.6）。

没有隔离什么：workspace-write 档的可写根 = 会话 cwd + **`/tmp` + `os.tmpdir()`**（`sandbox/src/roots.ts:54`），其中 `/tmp` 与 tmpdir 是**全机共享路径**。同一台机器上的两个 workspace-write 会话可以互相读写对方放在 /tmp 的文件——`/tmp` 常规的 `1777` sticky 位只防删除、不防读。更根本的是 **read-only 会话不可写但可读面不受限**（Seatbelt profile 只 deny `file-write*`），同 UID 下其他会话写入 /tmp 乃至工作区的内容都可读。`fs-sandbox` 围栏只做"写包含"（canonicalize-then-contain 到可写根，`packages/fs/fs-sandbox/src/index.ts`），既不是读隔离也不是安全边界。

例外与遗留：

- **Windows 是唯一有会话粒度的平台**：workspace-write 策略携带 sessionId 时，provider 为该会话物化随机私有临时目录 + 独立写 SID，runner 把子进程 `TMP/TEMP` 重写到该目录，其他会话无法用共享 workspace SID 进入（`sandbox-local/src/index.ts:369-430`）；read-only 或缺 sessionId 时仍回落共享 tmpdir()。
- **macOS/Linux 无对应机制**：子进程继承宿主环境，bash-local 的环境覆盖只有 `NO_COLOR/TERM/PAGER` 等（`bash-local/src/index.ts:27-32`），没有任何 per-session TMPDIR 重写。
- **框架自身落盘**：spill 输出溢出根是**进程级** mkdtemp 0700 目录（`spill/spill-local/src/store.ts:36-40`）——防其他 OS 用户，但同一 harness 进程内的所有会话共享，同 UID 的 bash 可读到其他会话的溢出输出。

落地建议（按成本排序）：

1. **每会话私有临时目录**（对齐 Windows 已有做法）：POSIX 执行器为每会话 mkdtemp 一个 0700 目录，重写子进程 `TMPDIR/TEMP/TMP`，并把可写根中的字面 `/tmp` 替换为该目录。改动点集中在执行器 env 与 `writableRoots()`（策略携带 per-session temp root），收益最大。
2. 补一个对齐 Codex `exclude_slash_tmp` 的配置旋钮（可把共享 /tmp 从可写根剔除），但**必须与私有目录配套**——Codex 的教训是"只剔除、无替代"，被沙箱命令会失去一切可写临时路径。
3. 更强隔离：Linux 用 bwrap `--tmpfs` 为每会话挂私有 /tmp；macOS 在 SBPL 中 deny 系统 /tmp、仅放行私有目录；或直接上容器/VM seam（§2.8 第 1 条）。
4. **读隔离是更根本的问题**：同 UID 同内核下文件级读隔离不存在。高敏感部署应以低权专用用户运行 harness、按会话拆容器，并把 /tmp sticky 位视为主机基线而非隔离机制。
5. 多会话部署中，spill/attachment 等框架自落盘目录也应按会话分目录。

### 5.2 专题二：bash 是白名单的逃逸通道（"通过 bash 运行未注册工具"）

**结论：工具白名单约束的是"模型面前的工具清单"，不是"机器上能发生什么"。**

只要"任意执行"面进了白名单，模型就可以用它调用任何**未注册**工具的等价 CLI：`bash: curl …` 代替 web_fetch、`bash: gh pr create` 代替未注册的 git 工具、甚至 `bash: codex exec …` 起一个嵌套智能体。DSH 的"任意执行"面共有四个，必须作为同一类能力整体取舍：`bash`、`pwsh`、`terminal_*`（持久终端）、`run_code`（PTC——在受沙箱策略约束的新 Node/Python 进程里执行模型编写的程序）。

DSH 现状盘点：

- **没有内置命令策略引擎**。guard 包只有重复调用提醒与超时两个插件（均不拦截，见 §3.4）；bash 工具内置的是沙箱模式与逐调用审批（`sandbox_permissions` 升级审批），没有"允许哪些命令"的概念。"bash 只准跑 X/Y/Z"在 DSH 必须**自建**。
- 现有的真实约束只有：沙箱模式（写限制；**网络不受限**——`bash: curl` 在 workspace-write 下默认可用）、逐调用人工审批、事后审计（`tool/result` 含完整命令）。

纵深建议（按层级）：

1. **取舍优先**：不需要 shell 就绝不放进 preset/restrict 白名单——唯一 100% 有效的手段。需要时优先提供窄化形态（限定工作目录的脚本化入口）。
2. **命令前缀 guard（需自建，约一天工作量）**：实现一个 `tools/pre-execute` 监听或 `tools.guard`，对 bash/pwsh/terminal 的命令做 argv 解析 + **前缀白名单**：只放行明确列出的程序（以及注册工具对应的 CLI）；`codex`/`claude`/`ssh` 等嵌套与外联入口默认拒绝；解析失败即拒绝；含管道/命令替换/重定向的"结构复杂命令"不做前缀放行，升级审批。形态可参考 Codex execpolicy（下条）。
3. **借引擎现成机制**：会话跑在 Codex 引擎上时，宿主 `~/.codex/rules` 的 execpolicy 前缀规则（Forbidden/Prompt/Allow）就是现成的命令级管控——DSH 已把这些 rules 镜像进会话 `CODEX_HOME`、解析交给原生运行时（`subagent-codex/src/user-config.ts`），**给宿主 rules 下发前缀规则即可约束引擎会话的 shell**。Claude 引擎无等价物，只有 SDK 权限规则镜像 + canUseTool 审批。
4. **沙箱与网络兜底**：read-only 挡写；网络是最大短板——对不允许出网的部署，禁 web 类工具只是第一道，网络层限制（代理/防火墙）必须做，否则 `bash + curl` 免费获得 web_fetch 的全部能力。
5. **审批与审计兜底**：bash 类工具保持 `approval: ask` 逐调用放行；所有 bash 调用的完整命令文本已落 `tool/result`，接入审计监听即可闭环。

### 5.3 两专题的新增验收项

- [ ] 双会话交叉验证：两个 workspace-write 会话并发，A 在临时目录写文件、B 读不到（POSIX 当前**会失败**——这正是 §5.1 要修的）；Windows 会话验证私有临时目录与 SID 生效。
- [ ] read-only 会话的跨会话读暴露面被评估并接受（读隔离只能靠 OS 用户/容器）。
- [ ] 白名单含 shell 时：前缀白名单 guard 能拒绝未注册 CLI、嵌套 agent CLI 与结构复杂命令（管道/命令替换升级审批）。
- [ ] 网络出口受控：禁 web 工具 + 网络层限制落地（DSH 沙箱不管网络）。

<a id="6"></a>

## 6. 关键文件索引

| 主题 | 文件 |
|---|---|
| 沙箱接缝/模式/失败分类 | `packages/sandbox/sandbox/src/index.ts`、`diagnostics.ts`、`escalation.ts`、`roots.ts` |
| 平台 profile 与链选择 | `packages/sandbox/sandbox-local/src/profiles.ts`、`index.ts` |
| Windows 限制令牌 | `packages/sandbox/sandbox-windows-acl/src/{runner,token,workspace-sid,grant,acl}.ts` |
| Landlock 原生 launcher | `native/landlock-run/packages/entry/lib/index.js` |
| 策略解析/会话模式 | `packages/sandbox/sandbox-policy/src/index.ts`、`session-mode.ts` |
| 执行接缝与隔离执行器 | `packages/shell/shell/src/types.ts`、`bash-sandbox/src/index.ts`、`bash-local/src/index.ts`、`tool-bash/src/index.ts` |
| 进程缝合 | `packages/subprocess/subprocess/src/index.ts`（env scrub）、`subprocess-local/src/{spawn,index,linux-scope,windows-job}.ts` |
| 审批/提问/预设 | `packages/interaction/user-approval/src/index.ts`、`user-questions/src/index.ts`、`permission-presets/src/index.ts` |
| 工具注册表与管线 | `packages/core/tools/src/index.ts`（restrict/guard/管线）、`schema.ts`、`ptc.ts` |
| 系统提示与 loop | `packages/core/system-prompt/src/index.ts`、`packages/core/agent-loop/src/{agent,tool-calls}.ts` |
| Preset 组合 | `packages/preset/agent-preset*/`、`packages/api/session-controller/src/agent.ts` |
| 子代理委派 | `packages/subagent/subagent/src/child-agent.ts`、`types.ts` |
| 引擎隔离与映射 | `packages/subagent/subagent-claude-code/src/{engine,run,user-memory}.ts`、`packages/subagent/subagent-codex/src/{engine,storage,user-config}.ts` |
| 子系统文档 | `docs/subsystems/{sandbox,shell,subprocess,approval}.md`、`docs/architecture.md`、`docs/defensive-patterns.md` |
