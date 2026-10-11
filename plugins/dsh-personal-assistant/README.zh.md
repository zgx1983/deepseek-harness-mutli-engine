---
description: "只读看板，按今天和最近七天展示项目、会话活动与提供方报告的 token 用量。"
kind: package-reference
---

# dsh-personal-assistant

[English](README.md) | 中文

## 概述

插件在应用侧边栏提供一个看板，汇总本地当天与最近七天内活跃的项目和会话、新建会话，以及提供方报告的 token 用量。用量包括输入、输出、缓存读取、缓存写入，以及单条消息或引擎累计数据报告的额外 token。当天图表按小时展示，七天图表按日期展示。token 计数使用中文紧凑单位（万、亿）并保留两位小数；英语界面使用 K、M 等紧凑单位。项目归属来自工作区注册表；无法匹配工作区的会话归入“未归属项目”。

## 数据与限制

Host 通过 `sessionQuery` 读取会话列表和日志，通过 `workspaceRegistry` 读取项目归属。token 用量按浏览器提供的 IANA 时区和事件时间统计 assistant 消息中的提供方用量。缓存读写量与未缓存输入分开统计；单条消息总量以及 Codex、Claude 的引擎累计量只补入明细中尚未包含的部分，避免重复计数。分叉会话继承的事件会排除，以免重复计数。在某个周期内包含用户或 assistant 消息的会话计为活跃；会话创建时间用于统计新建会话。

提供方可能不返回用量，因此 token 总量可能低于实际消耗。引擎累计量中未出现在逐条明细里的 token 记在累计报告发生的时间。无法读取的会话会从统计中略过，并显示数量提示。看板快照缓存一分钟；点击“刷新”会重新读取。生成快照需要扫描逻辑会话目录及其日志，历史较多时刷新需要更久。

看板取代此插件原有的任务、Todo、个人知识和助理对话功能；原 HTTP 路由、模型工具、配置字段和存储域路由均不再挂载。已有 Session 日志和旧的 `personal_assistant.db` 文件会保留；看板不会读取或修改任务数据库。

## 组合方式

在浏览器 profile 中加入 `dsh-personal-assistant`。它依赖标准的 `sessionQuery`、`workspaceRegistry`、locale、侧边栏和主面板服务。插件注册经过认证的 `GET /api/personal-assistant/dashboard` 路由，不写入持久数据，也没有插件专属设置。

## 文件索引

| 文件 | 职责 |
|---|---|
| `src/dashboard.js` | 读取会话目录，按本地日期汇总项目、会话和 token 用量 |
| `src/index.js` | 注册经过认证的看板路由 |
| `src/client.jsx` | 注册侧边栏入口并显示周期、项目、会话和 token 汇总 |
| `src/locales.js`、`src/css.js` | 本地化文案和主题样式 |
| `cordis.patch.yml`、`build.mjs` | 浏览器 profile 注册及 Host/Client 打包 |
