# 团队流程图默认折叠 —— 设计方案

> 需求：Agent Team 下拉菜单点击「团队」后，右侧团队视图中的「流程执行图」目前默认展开；改为默认折叠，用户仍可手动展开。
> 范围：只设计，不改产品源码。本文件是唯一确定的产物文件。

## 1. 结论摘要

- 目标组件是右侧栏「团队」页的「流程执行图」区域（`TeamDashboard.tsx`），不是下拉菜单本身。
- 展开/折叠由 `fold-state.ts` 的 `useFold(teamId, fold, defaultExpanded)` 控制，默认值在调用点传入。
- 必改点只有一处：`packages/experimental/client-ui-agent-team/src/client/TeamDashboard.tsx:40` 把 `useFold(root, 'flow', true)` 的默认值从 `true` 改为 `false`。
- 折叠态复用现有 `TeamSection`：标题「流程执行图 / Execution flow」+ 右向 chevron 常驻，正文（`TaskDependencyGraph`）不挂载。
- 不需要新增 i18n 文案，不需要改 `collapse-preferences.ts` 存储键，不需要改任何 recorded-session snapshot。

## 2. 定位结论（文件:行）

### 2.1 下拉菜单入口与「团队」视图

- 头部下拉入口：`packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx`
  - `data-team-action` 触发按钮（`:275` 附近），点击后在 `document.body` 上以 portal 渲染 `role="dialog"` 的面板，`aria-label` = `t('trigger')` = 「智能体团队 / Agent Team」（`:295-306`）。
  - 面板内「在右侧查看团队 / Show Team in sidebar」按钮调用 `openDashboard(sessionId)`（`:308`），由 `mount.ts` 的 `openDashboard` 打开右侧栏团队页（`ctx.sidebarRight.openTabIn(sessionId, 'agent-team')`）。
- 右侧栏注册：`packages/experimental/client-ui-agent-team/src/client/mount.ts`
  - `sidebarRightTabs.register({ kind: 'agent-team', ... })`（`:42-45`）注册团队标签。
  - `sidebar.right.pane.tab` 槽注册 `TeamDashboard`（`:65-67`）与 `TeamDashboardTitle`（`:68-70`）。
- 右侧栏团队页：`packages/experimental/client-ui-agent-team/src/client/TeamDashboard.tsx`。

### 2.2 流程图组件与展开/折叠状态

- 流程图组件：`packages/experimental/client-ui-agent-team/src/client/TaskDependencyGraph.tsx`
  - 只读任务依赖图（节点/箭头/图例/适应视图/缩放/平移/全屏），只在 `TeamDashboard` 中引用（`TeamDashboard.tsx:12` 导入、`:58` 使用）。
  - 「流程执行图」文案键：`flow.title`（`locales.ts:60` 中文「流程执行图」、`:135` 英文「Execution flow」）。
- 折叠容器：`packages/experimental/client-ui-agent-team/src/client/TeamSection.tsx`
  - `TeamSection` 折叠时标题头常驻，正文 `{expanded && ...}` 条件渲染（`:55`）。折叠态样式已存在：`.sectionArrowClosed { transform: rotate(-90deg) }`（`TeamAction.module.css:412`）。
  - `flow` 区域的渲染在 `TeamDashboard.tsx:57-62`：`TeamSection title={t('flow.title')} expanded={flowFolds[0]} onToggle={flowFolds[1]}`，正文为 `TaskDependencyGraph`。
- 状态的默认值：`TeamDashboard.tsx:40`
  ```ts
  const flowFolds = useFold(root, 'flow', true)
  ```
  第三个参数 `true` 即「无存储覆盖时的默认展开」，这是需求要改的地方。
- 状态 hook：`packages/experimental/client-ui-agent-team/src/client/fold-state.ts`
  - `useFold` 契约（`:18-27`）：返回 `[stored.value ?? defaultExpanded, setExpanded]`（`:26`）。只有不存在存储覆盖时才用 `defaultExpanded`。

### 2.3 持久化情况

- `packages/experimental/client-ui-agent-team/src/client/collapse-preferences.ts`
  - 存储键 `STORAGE_KEY = 'dsh.agent-team-panel.v1'`（`:4`），信封结构 `Team root Session id → 折叠键 → boolean`。
  - `readFold(teamId, fold)`（`:45-47`）读单个选择，无选择返回 `undefined`；`writeFold`（`:55-59`）写单个选择。
  - 折叠键约定：区域用 `flow`，分组用 `members/<group>`、`tasks/<group>`（`TaskDashboard.tsx:40`、`TeamDashboard.tsx:41`、`TaskGroups.tsx:74`）。
- 持久化语义：只写「用户显式切换过的键」，未写过 `flow` 键的团队走默认值。因此改默认值对已显式收起/再展开流程图的用户不覆盖其选择，只影响从未操作过 `flow` 折叠的用户，这正是「默认折叠」的合理语义。

## 3. 改动方案（逐文件）

### 3.1 必改：`TeamDashboard.tsx:40`

把流程区域默认展开改为默认折叠：

```diff
-  const flowFolds = useFold(root, 'flow', true)
+  const flowFolds = useFold(root, 'flow', false)
```

- 需要修改的符号：`useFold` 调用的第三个实参（`defaultExpanded`）。
- 不新增/删减任何 prop、常量、组件、hook。

### 3.2 不需要改、但要在方案中说明的文件

- `fold-state.ts`：`useFold`/`useAreaFolds` 机制不变；`useAreaFolds.areaExpanded` 默认 `true`（`:85`）只作用于成员、任务区域，与流程区域无关，保持不变。
- `TeamSection.tsx`、`TeamAction.module.css`：折叠渲染、右向 chevron、`aria-expanded`/`aria-controls`、焦点返还均已具备，无需改动。
- `collapse-preferences.ts`：存储「信封形状」未变（仍是 `teamId → foldKey → boolean`），`STORAGE_KEY` 后缀无需 bump。不清理、不迁移已有 `flow` 覆盖值。
- `locales.ts` 与 `locale/{zh,en}.json`：无新文案。`locale/zh.json`/`locale/en.json` 只是插件元信息（title/description），不是 UI 字典；UI 文案在 `src/client/locales.ts`（`NS = 'agent-team'`）。

### 3.3 文档同步（开发阶段应随代码一起更新）

- `packages/experimental/client-ui-agent-team/README.zh.md:44`（「折叠区域与流程执行图」段）与 `README.md:44`：补充「流程执行图默认折叠，用户可点击标题展开」，与既有「已完成默认折叠」的表述并列。可选在 `README.md`/`README.zh.md` 的第 23 行（三区域概述）一并补一句默认态。

## 4. 折叠态交互细节

- **折叠态展示**：`TeamSection` 标题头常驻，显示标题「流程执行图 / Execution flow」+ 右向 chevron（`sectionArrowClosed` 已旋转 -90°），`aria-expanded="false"`。正文（`TaskDependencyGraph` 的工具栏、SVG 画布、图例、选中详情）完全不渲染，因此：
  - 不显示任何节点、连线、控制按钮。
  - 无额外占位或空态——流程区域本就没有「摘要计数」，折叠头就是纯标题（与现状展开态下头部一致，仅正文消失）。
- **展开入口**：点击折叠头（标题按钮）即展开；这是现有 `TeamSection` 标题 toggle，键盘可操作。
- **展开后行为**：与现状完全一致——`TaskDependencyGraph` 挂载、首次适应画布、可选节点并联动展开任务看板定位（`TeamDashboard.tsx:59-61` 的 `onSelectTask` 逻辑不动）。流程区为空时展开后显示 `flow.empty`「暂无任务」。
- **节点选择联动不受影响**：只有流程区处于展开态、节点可见时才能点选节点；折叠态下不存在节点，因此「点节点展开任务看板并定位」自然只在展开后可用。

## 5. i18n 评估

- 结论：**无需新增/修改文案**。`verify-client-ui-i18n` 仍通过（未引入硬编码 copy）。
- 文案涉及文件（备查，若后续决定给折叠头加计数/摘要时才需要动）：
  - `packages/experimental/client-ui-agent-team/src/client/locales.ts`：`zh` 与 `en` 两个字典（`NS = 'agent-team'`），`flow.title` 现行值为「流程执行图 / Execution flow」。
  - `packages/experimental/client-ui-agent-team/locale/zh.json`、`locale/en.json`：插件元信息字典，不是本需求范围。
- 若采纳可选增强（见 §8 待确认②）：新增一条类似 `flow.summary` 的键，需在 `zh` 与 `en` 字典同步补齐，并维持 `en satisfies Record<TeamKey, string>` 的键集对齐。

## 6. 测试影响

### 6.1 单元测试（受影响，需更新）

文件：`packages/experimental/client-ui-agent-team/tests/team-flow.client.spec.tsx`（`beforeEach` 会 `localStorage.clear()`，所以下面用例都会命中「无存储覆盖 → 新默认折叠」）。

| 用例（文件:行） | 影响 | 更新方式 |
| --- | --- | --- |
| `reveals the matching card from a flow node even when tasks are collapsed`（`:716-738`） | **会失败**：`:731` 用 `getByRole('button', { name: /Task done/u })` 点流程节点，但流程默认折叠后节点不渲染，`getByRole` 抛错 | 在 `:731` 之前先展开流程区：`fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['flow.title'], 'u') }))` |
| `resets the reveal request when the Team root changes`（`:740-750`） | **会失败**：`:743` 点流程节点 `/Implement runtime/`，流程默认折叠后节点不渲染 | 在 `:743` 之前先展开流程区（同上） |
| `stacks flow, members, and tasks with a members summary`（`:544-559`） | 不受影响：`flow.title` 的标题头在折叠态也常驻，`:547` 只断言标题 | 无需改 |
| `shows the unavailable notice or engine children before a Team arrives`（`:518-542`） | 不受影响：`:540` 只断言流程标题存在 | 无需改 |
| `useFold keeps defaults, stores overrides...`（`:192-206`） | 不受影响：该用例显式传 `useFold(teamId, 'flow', true)`，测试 hook 契约而非组件默认值 | 无需改；可另加一条 `useFold('x', 'flow', false)` 默认折叠的断言 |
| `TeamDashboard` 其余用例（`:515` 之后） | `TeamDashboard` 里与流程正文无关的断言（成员、任务、错误、导航）不受影响 | 无需改 |

建议随改动新增一条**回归测试**（放在 `TeamDashboard` describe 内），把新默认钉死：

```tsx
it('keeps the execution flow collapsed by default and expandable on demand', () => {
  const b = bench()
  render(<TeamDashboard {...b.props} {...tabProps} />)
  const flowToggle = screen.getByRole('button', { name: new RegExp(zh['flow.title'], 'u') })
  expect(flowToggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: /Implement runtime/u })).toBeNull()
  fireEvent.click(flowToggle)
  expect(screen.getByRole('button', { name: /Implement runtime/u })).toBeTruthy()
  expect(readFold('lead', 'flow')).toBe(true)
})
```

文件 `tests/team-action.client.spec.tsx`：`it.each(['header', 'dashboard'])`（`:32-54`）的 dashboard 分支只断言任务看板标题/时间，不触碰流程正文，**无需改**。`tests/browser-plugin.client.spec.ts` 只做注册冒烟，**无需改**。

### 6.2 recorded-session snapshot（无需更新）

- `apps/web/tests/snapshots/agent-team-panel/task.expected.md`、`resize.expected.md`：快照目标是 `[data-team-panel]`，即**头部下拉面板**（`TeamAction`），其内容为成员、任务看板、引擎子项，**不含** `TaskDependencyGraph`。因此不受默认折叠影响。
- `snapshots/session/team-targets/system-prompt.expected.md`：这是模型可见的 Team 工具 system-prompt，与客户端 UI 折叠无关，**无需更新**。
- 结论：本次改动不触发任何 recorded-session snapshot 的重新录制。审批方若要求按「产品可见变更必须有快照」补齐覆盖，属于新增覆盖而非更新既有快照，见 §8 待确认③。

### 6.3 apps/web e2e（无需更新，可选补充）

- `apps/web/tests/agent-team-panel.e2e.ts`：全程只操作头部 `[data-team-action]` 与 `role=dialog` 面板，从未点击「Show Team in sidebar / 在右侧查看团队」打开右侧栏团队页，因此不覆盖流程区，**无需改**。
- `apps/web/tests/plugin-manager.e2e.ts:631-637`：同样只断言头部面板（「Team 暂不可用」「暂无共享任务，可以通过对话创建」「lead」），**无需改**。
- 可选增强：在 `agent-team-panel.e2e.ts` 增加一步——打开右侧栏团队页，断言流程标题 `aria-expanded="false"`（默认折叠），点击标题后断言 `Execution flow` 的 SVG 节点出现。这能填补「右侧栏 Dashboard 无 e2e 断言」的空白，但不是本次最小改动的强制项。

## 7. 验收标准（开发/构建 agent 可直接核对）

1. `packages/experimental/client-ui-agent-team/src/client/TeamDashboard.tsx:40` 的实参为 `false`：`useFold(root, 'flow', false)`。
2. 在干净浏览器环境（无 `dsh.agent-team-panel.v1` 中 `<root>/flow` 覆盖）打开右侧栏团队页：
   - 流程区标题「流程执行图 / Execution flow」可见，其切换按钮 `aria-expanded="false"`；
   - 页面中没有 `TaskDependencyGraph` 的 SVG 节点（`g[role="button"]`）与适应视图/缩放/全屏按钮。
3. 点击流程区标题后 `aria-expanded="true"`，`TaskDependencyGraph` 完整挂载；fit/zoom/pan/全屏/节点选择→展开任务看板定位 等行为与改动前一致。
4. 用户手动展开后重新挂载 Dashboard：读取到 `dsh.agent-team-panel.v1[<root>].flow === true` 并保持展开；用户再收起则保持收起。存储键与信封结构不变，不 bump `STORAGE_KEY`。
5. `pnpm run test`（聚焦 `packages/experimental/client-ui-agent-team/tests/team-flow.client.spec.tsx`）通过；两个受影响的用例已补「先展开流程区」的前置步骤，新增回归用例同时存在。
6. `verify-client-ui-i18n` 通过（未引入硬编码文案，复用 `flow.title`）。
7. 如需文档同步：`README.zh.md:44` 与 `README.md:44` 增加「流程执行图默认折叠」说明，与既有「已完成默认折叠」并列。

## 8. 待确认事项与推荐取舍

1. **存量本地偏好的解释**：改默认值只影响从未操作过 flow 折叠的用户；曾显式收起、再展开的用户仍保留其 `flow: true` 覆盖。推荐接受这一语义（尊重显式选择），不 bump 存储键、不迁移旧值。
2. **折叠头是否补计数/摘要**：流程区现状无 `count`/`summary`（与成员、任务区不一致，属既有状态）。推荐最小改动不加；若产品要求折叠态更信息密集，可加 `flow.summary` 并在计数语义（任务数 vs 节点数，占位节点）上取任务数，但会引入新文案与更多测试面。
3. **覆盖缺口**：右侧栏 Dashboard 及其流程区当前没有 e2e 快照覆盖。推荐以单元回归测试（§6.1）作为本次验收必选，e2e 补断言作为可选。