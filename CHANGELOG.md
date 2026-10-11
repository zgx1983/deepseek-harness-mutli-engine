# Changelog

## 2026-10-10T22:06:06.044Z — Session session-6cc6bbde-189c-4a36-b877-bcbc1c832b4a

- 目标:分析 DSH 是否有类似 Claude Code 的 memory 机制,以及 claude/codex 引擎能否启用原生记忆。
- 结论:DSH 有会话事件日志、agent-instructions(AGENTS.md/CLAUDE.md)、session-reference 等分层机制,但无独立条目式 memory 库;跨会话记忆仅靠第三方 MCP(默认关闭)。
- 验证:跑通 22 个镜像单测并核对调用链,确认引擎只镜像 CLAUDE.md/AGENTS.md/skills,不碰记忆库;Claude SDK 的 config/rules 镜像代码未接线。
- 关键发现:Claude SDK 可用 Options.settings 注入 autoMemoryEnabled/autoMemoryDirectory;Codex 0.153.4 有 [memories] 配置段(generate_memories/use_memories/dedicated_tools),可经 -c 嵌套键透传。
- 未解决:DSH 尚未接入上述开关;启用需改 main-adapter/engine configArgs,并补 memory_recall 消息到 session 事件的渲染。

## 2026-10-10T22:16:22.086Z — Session session-368634a0-ad48-4ada-b79b-f39c1bd5abf3

- 目标：将个人助理页改为中栏任务工作台、右侧常驻对话，并继续优化工作台视觉密度。
- 已完成：对话迁入共享右栏并使用嵌入式 `conversation.content`；执行会话和旧对话在右栏切换；中栏宽度提升至 1200px。
- 已完成：移除“个人工作台”重复标题，任务卡改为单行展示标题、项目、状态和相对时间，悬停或聚焦时显示会话操作。
- 关键决策：复用共享右栏的宽度、折叠、全屏和会话绑定能力，不为个人助理另建侧栏。
- 未解决：真实 Web/Desktop 界面验收仍待重启 profile 后进行。
