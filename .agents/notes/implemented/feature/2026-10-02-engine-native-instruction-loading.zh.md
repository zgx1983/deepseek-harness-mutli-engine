# Agent Note: 引擎会话像原生 CLI 一样加载宿主机指令文件

Status: implemented

[English](2026-10-02-engine-native-instruction-loading.md) | 中文

## 问题

Claude 与 Codex 主引擎此前把会话与宿主机的指令文件隔离开。Claude 引擎向 Agent SDK 传 `settingSources: []`（禁用全部 CLAUDE.md 层级），并把 `CLAUDE_CONFIG_DIR` 重定向进 Harness home，因此 `~/.claude/CLAUDE.md` 和工作区的 CLAUDE.md/AGENTS.md 都到不了模型。Codex 引擎把 `CODEX_HOME` 重定向到按会话哈希的 home，全局 `~/.codex/AGENTS.md` 从不加载，而项目级 AGENTS.md（基于工作区解析）仍然加载。同一个任务在手工运行的 CLI 里和在 Harness 里行为不同，用户或部署方为 CLI 编写的指引在 Harness 里悄悄失效。

## 决策

**两个主引擎默认采用原生 CLI 的指令加载行为，同时保留存储隔离。** Claude 引擎的部署配置新增 `settingSources`，默认覆盖全部三个层级（即 CLI 自身行为），替换主适配器里硬编码的 `[]`；由于 `CLAUDE_CONFIG_DIR` 仍为设置、凭据与会话隔离而保持重定向，当解析后的来源包含 `user` 时，引擎在启动前把宿主机的 `~/.claude/CLAUDE.md` 镜像进该目录。Codex 引擎在每次准备时把宿主机的 `~/.codex/AGENTS.md` 镜像进按会话划分的 `CODEX_HOME`，使原生的全局指令查找能读到它；部署字段 `mirrorUserInstructions: false` 可关闭镜像。镜像在每次引擎准备时刷新内容，源文件消失时移除镜像，因此编辑与删除都会传播。

## 曾考虑的替代方案

- **让两个引擎直接指向真实的 `~/.claude` / `~/.codex`**——否决：会话、转录、自动记忆与设置会与用户自己的 CLI 状态双向混杂，破坏恢复与凭据隔离所依赖的引擎自有存储。
- **通过系统提示词追加通道注入文件内容**——否决：绕开了各 CLI 自己的加载语义（Claude 的 `@import` 解析、层级框架），且会随引擎各自漂移。
- **默认保持完全隔离、以显式开关打开**——否决：引擎存在的意义就是复现 CLI 的执行，而指令文件是 CLI 明文约定的上下文通道；需要隔离的部署可以收窄 `settingSources` 或显式关闭镜像。

## 影响

`project` 与 `local` 层级不可再分：启用它们时，仓库的设置、skills 与 hooks 也会像原生 CLI 一样加载，且 hooks 运行的原生命令不受 Harness 的 `canUseTool` 门控——这与手工运行 CLI 的暴露面相同，作为对齐的代价在此记录。用户 CLAUDE.md 中的 `@import` 相对路径会相对于引擎 home 里的镜像副本解析，而不是原目录。镜像是内容复制（而非符号链接），因此在 Windows 上无需提权即可工作，且仅在内容变化时才重写。

## 相关

- [会话引擎选择](../architecture/2026-09-29-session-engine-selection.zh.md)——该加载行为所属的引擎机制。
