---
kind: upgrade-guide
description: "移除 `/engine-recover` 命令；不确定的原生投递改为自动确认，不再阻断输入。"
---

# 移除 `/engine-recover`

[English](guide.md) | 中文

## 变更

`/engine-recover continue` 斜杠命令从 `@deepseek-ai/dsh-session-controller` 移除。此前，当 Claude 或 Codex 引擎会话中某次投递缺少持久化的终端结算时，所有新输入都会被阻断，需要用户手动确认缺口。

不确定的投递现在自动确认：失败回合会记录 `engine/turn-settled { outcome: 'acknowledged-uncertain' }`，写入进程崩溃则在下一次引擎准备时补记。旧输入仍然不会重新提交，原生会话标识保持不变，下一次提示从引擎自身历史恢复——该历史仍是实际执行情况的权威记录。此前显示 "External input delivery is uncertain" 错误的会话无需任何手动操作即可重新接受输入。

受影响用户：所有曾调用该命令的外部引擎（Claude Code、Codex）会话使用者，以及通过命令 API 发送过该命令的脚本。

## 迁移

1. 从面向外部引擎会话的脚本或保存的提示中删除 `/engine-recover continue` 调用；无需任何替代操作。
2. 重启应用并打开此前被阻断的会话。确认发送提示成功，且会话日志中此前挂起的输入已出现一条 outcome 为 `acknowledged-uncertain` 的 `engine/turn-settled` 记录。
