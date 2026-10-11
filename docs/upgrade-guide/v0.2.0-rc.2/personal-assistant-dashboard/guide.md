---
kind: upgrade-guide
description: "The personal-assistant plugin replaces task, Todo, knowledge, and assistant-chat features with a project and token dashboard."
---

# Personal assistant becomes a project dashboard

English | [中文](guide.zh.md)

## Change

The `dsh-personal-assistant` plugin now displays project and session activity with provider-reported token usage. Its task and Todo management, personal knowledge tools, assistant conversation, configuration settings, and `/api/personal-assistant/config` and `/api/personal-assistant/tasks` routes are removed. The plugin no longer mounts the `personal_assistant` storage routes.

## Migration

1. If you need existing task, Todo, or knowledge records, back up `$DSH_HOME/storages/personal-assistant.db` before upgrading. The new plugin leaves the file untouched but provides no UI, API, or migration for those records.
2. Remove clients that call `/api/personal-assistant/config` or `/api/personal-assistant/tasks`, and remove workflows that depend on the plugin's model tools or settings.
3. Enable the updated `dsh-personal-assistant` browser plugin. Confirm the sidebar opens the project dashboard and that Refresh updates the local-day and seven-day summaries.
### Session archival

Archiving a Session opens a confirmation dialog whose summary checkbox is unchecked by default. Selecting it continues the original Session through its native, Codex, or Claude engine. The engine receives one brief summary prompt with the absolute project-root `CHANGELOG.md` path, and uses its own file or shell tools to append a timestamped entry. The Host verifies the entry before archiving; it no longer writes the file. Summary failures leave the Session visible; engine file changes are retained. Existing tool permissions apply. Existing project files need no migration.

Replace the independent-call settings `changelogSummaryMaxInputBytes` and `changelogSummaryMaxTokens` with `changelogSummaryMaxCharacters` (default `800` Unicode characters in the appended body) and `changelogSummaryTimeoutMs` (default `120000` milliseconds) on the Host `workspaceController`. The engine owns its existing context; no separate transcript input is sent. A timeout requests cancellation and waits for the Agent to settle. Confirm that opting in adds a summary reply to the same conversation and a timestamped changelog entry; opting out only archives.
