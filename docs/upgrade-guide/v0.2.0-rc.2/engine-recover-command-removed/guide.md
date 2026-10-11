---
kind: upgrade-guide
description: "Remove the `/engine-recover` command; uncertain native delivery is acknowledged automatically instead of blocking input."
---

# Remove `/engine-recover`

English | [中文](guide.zh.md)

## Change

The `/engine-recover continue` slash command is removed from `@deepseek-ai/dsh-session-controller`. It previously blocked every new prompt in a Claude or Codex engine session whose prior delivery had no durable terminal settlement, and required the user to acknowledge the gap manually.

Uncertain delivery is now acknowledged automatically: the failing turn records `engine/turn-settled { outcome: 'acknowledged-uncertain' }`, and a writer crash is repaired at the next engine preparation. Prior input is still never resubmitted, the native session binding is unchanged, and the next prompt resumes the engine's own history, which stays authoritative for what actually ran. Sessions that previously showed the "External input delivery is uncertain" error accept input again without any manual step.

Affected users: anyone running external engine (Claude Code, Codex) sessions who invoked the command, and any script that sent it through the commands API.

## Migration

1. Remove `/engine-recover continue` invocations from scripts or saved prompts that target external engine sessions; no replacement action is needed.
2. Restart the application and open a previously blocked session. Confirm that sending a prompt succeeds and that the session log contains an `engine/turn-settled` record with outcome `acknowledged-uncertain` for the previously pending input.
