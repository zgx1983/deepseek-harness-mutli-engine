# dsh-recent-sessions

[English](README.md) | 中文

## 「最近」区块

纯 Client 插件，填充侧栏外壳的 `sidebar.recent` 洞位：在工作区浏览器之上以并行区块列出未读（待交互或未查看的完成）、进行中和今日会话，按此优先级排列。每个桶内按最近更新倒序；折叠时显示前七行，其余经展开/收起控制查看，区块标题可折叠整个列表。个人助理的任务执行会话与普通会话一样正常入选，只有助理的常驻对话经目录排除不显示。行内在会话名前冠以其所属工作区名（`项目/会话名`），名称过长时保留前面的字符。折叠成窄栏时不渲染任何内容。

空白（临时新会话）、已归档和 subagent 子会话永不入选——被委派子会话的唯一入口是父会话的子智能体面板。从目录隐藏的会话（例如个人助理的固定会话）同样不入选，因为目录排除会把它们从本投影读取的 Host 列表中移除。点击行通过共享的 `uiWorkspace` 服务导航打开。

插件经 `slots.inject` 等待外壳的洞位声明，与 ui-sidebar 的激活顺序无关。外壳负责声明洞位；本插件是它唯一的占用者。

## 配置与加载

包根导出不安装 Host 行为的加载入口；`./client` 提供浏览器 bundle。客户端注入列表包含 ui-primitives，用于图标、状态点和相对时间。

无配置。在仓库内执行 `node plugins/dsh-recent-sessions/build.mjs` 构建，再打包经 profile 插件管理器安装。bundle 只启用 `ui-recent-sessions`。运行中的 ui-sidebar 构建必须声明 `sidebar.recent` 洞位；面对不含该洞位的构建，注册会在加载时显式失败。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `src/index.js` | `apply` 提供不安装 Host 行为的加载入口 |
| `src/client.jsx` | `apply` 注册词典、样式与 `sidebar.recent` 占用者；`RecentSessions` 渲染区块 |
| `src/recent.js` | `deriveRecentSessions` 投影入选行与折叠隐藏数 |
| `src/locales.js`、`src/css.js` | 本地化文案与区块样式 |
| `cordis.patch.yml`、`build.mjs` | 激活设置与 ModuleLoader 客户端 bundle |
