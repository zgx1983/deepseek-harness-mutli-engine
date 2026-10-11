---
description: "A read-only dashboard of project and session activity with provider-reported token usage for today and the last seven days."
kind: package-reference
---

# dsh-personal-assistant

English | [中文](README.zh.md)

## Summary

The plugin adds one dashboard to the application sidebar. It summarizes active projects and sessions, newly created sessions, and reported token usage for the local day and the last seven days. Token totals include input, output, cache-read, cache-write, and any remainder reported by per-message or cumulative engine totals. The daily chart groups usage by hour; the weekly chart groups it by day. Token counts use compact units: 万 and 亿 with two decimal places in Chinese, and K/M in English. Project membership comes from the workspace registry; sessions without a matching workspace appear under the unassigned project.

## Data and limits

The Host reads session headers and logs through `sessionQuery` and reads project membership through `workspaceRegistry`. It counts provider-reported usage on assistant messages by event time and the browser's IANA timezone. Cache buckets remain separate from uncached input. Per-message totals and Codex or Claude cumulative engine totals add only usage beyond the itemized amounts, avoiding duplicate counts. Fork-inherited events are excluded to avoid counting the same usage twice. A session counts as active in a period when it contains a user or assistant message in that period; a session counts as new by its creation time.

Providers may omit usage, so reported token totals can be lower than actual consumption. Cumulative engine usage beyond itemized messages is assigned to the time of its cumulative report. Sessions that cannot be read are omitted and shown as an incomplete-session count. A dashboard snapshot is cached for one minute; Refresh requests a new snapshot. Building a snapshot reads the logical session corpus and its logs, so large histories take longer to refresh.

The dashboard replaces the plugin's former task, Todo, personal-knowledge, and assistant-conversation features. Their HTTP routes, model tools, configuration fields, and storage-domain routing are no longer mounted. Existing Session logs and the old `personal_assistant.db` file are left in place; the dashboard does not read or modify the task database.

## Composition

Add `dsh-personal-assistant` to the browser profile. It requires the standard `sessionQuery`, `workspaceRegistry`, locale, sidebar, and main-panel services. It registers the authenticated `GET /api/personal-assistant/dashboard` route and has no persistent writes or plugin-specific settings.

## Source map

| File | Role |
|---|---|
| `src/dashboard.js` | Reads the session corpus and folds project, session, and token totals into local-day buckets |
| `src/index.js` | Registers the authenticated dashboard route |
| `src/client.jsx` | Registers the sidebar entry and renders period, project, session, and token summaries |
| `src/locales.js`, `src/css.js` | Localized copy and theme styles |
| `cordis.patch.yml`, `build.mjs` | Browser-profile registration and Host/Client bundling |
