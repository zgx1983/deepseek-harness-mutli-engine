# [ui-recent-sessions] 「最近」分区未排除 subagent 子会话

## 环境

- dsh `0.1.7-rc.2`
- 插件 `@deepseek-ai/dsh-client-ui-recent-sessions@0.1.7-rc.2`（desktop profile，`file:` 本地 tarball 安装）
- 平台：macOS / Electron 桌面端

## 现象

主会话通过 `subagent` 委派子任务后，子会话会作为顶层行出现在侧边栏「最近」分区（位于「工作区」之上），且不携带任何项目归属；同时它们在工作区浏览器中完全不可见。

复现：让任意主会话并行委派 2–3 个 subagent，观察侧边栏「最近」分区。

## 期望

子会话不出现在「最近」分区，与工作区浏览器保持一致。子会话的唯一入口是父会话的子智能体面板。

## 根因

同一份 `SessionListState.ids` 被侧边栏的两个分区各自投影，而两套筛选条件不一致。

### 1. 最近分区：没有 subagent 概念

`src/client/recent.ts:108-110`：

```ts
for (const id of input.list.ids) {
  const summary = input.list.byId[id]
  if (summary === undefined || summary.blank || input.archived.has(id)) continue
```

该谓词只跳过「无 summary / blank / 已归档」。对 `src/` 全目录执行 `grep -rn "subagent\|origin"` 零命中，即这个包完全不知道 `origin: 'subagent'` 的存在。

子会话因此以两个理由入选：运行期间命中 `running` 桶，创建当天命中 `today` 桶。`RecentSession` 接口没有 workspace 字段，该分区本就是扁平投影，所以子会话显示为无归属的顶层行。

### 2. 工作区浏览器：显式排除

`packages/client/ui-workspace/src/client/tree.ts:244`：

```ts
if (session.origin === 'subagent') return false
```

这条对工作区树、单列模式、未分组桶、搜索结果全部生效，子会话因此不出现在任何项目下。

## 证据

子会话 header 的归属信息是完整的：

```json
{"type":"session","version":4,"id":"a3607bfb-…",
 "cwd":"/Users/hhh/.codex/worktrees/e2a7/deepseek-harness",
 "parentSession":"session-e199bb3f-…","origin":"subagent","delegationDepth":1}
```

所以这不是 `cwd` 或 `parentSession` 缺失，而是最近分区不读这两个字段。

## 建议修复

在 `recent.ts:110` 的跳过条件中加入 subagent 判定：

```ts
if (summary === undefined || summary.blank || summary.origin === 'subagent' || input.archived.has(id)) continue
```

同步改动：

- `tests/recent.client.spec.ts` 增加「subagent-origin session does not qualify」用例，覆盖 `running` 与 `today` 两个桶
- `tests/recent-sessions.client.spec.tsx` 按需断言渲染层不再出现该行
- README 的 `## Known Limitations and Deferred Work` 记录：子会话的唯一入口是父会话的子智能体面板；父会话归档后子会话不可达

## 附：一个独立的相关缺口（不在本 issue 范围）

子会话从未被加入工作区成员表。生产代码中只有两处 `workspace.attachSession()`，都在 `packages/api/session-controller/src/commands.ts`（`session.create` 第 138 行、`session.fork` 第 358 行）；而 subagent 子会话由 `packages/subagent/subagent-in-process-driver/src/index.ts:134` 的 `parent.ctx.agents.create()` 直接创建，绕过这两条路径，冷恢复同理（`packages/subagent/subagent/src/continuation-activation.ts:641`）。

后果：`~/.dsh/storages/workspace.json` 中只登记了父会话。实测命中次数为父会话 1 次、三个子会话各 0 次。

当前这不影响可见性，因为工作区树另有 `sessionVisible` 拦截；但若将来要让子会话出现在项目下，必须先补上这条成员资格。
