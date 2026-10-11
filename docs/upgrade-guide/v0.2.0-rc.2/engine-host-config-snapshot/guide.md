---
kind: upgrade-guide
description: "Harness no longer reads host Claude or Codex permission configuration; the session permission preset is the only permission source."
---

# Host engine permission configuration is no longer read

English | [中文](guide.zh.md)

## Change

The Claude engine previously mirrored the `permissions` section of `~/.claude/settings.json` into its config home, and the Codex engine previously mirrored permission fields of `~/.codex/config.toml` plus every `~/.codex/rules/*.rules` file into each session home, with host values overriding the session permission preset field by field.

Both engines no longer read those host files. The session permission preset is now the only permission source: Claude maps full access to `bypassPermissions` and workspace write to `acceptEdits`; Codex maps each preset straight onto the thread sandbox, approval policy, and reviewer. Host permission rules can neither restrict nor redefine a session. Non-permission memory still mirrors (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, skills).

The deployment keys `permissionMode` and `settingSources` on the Claude main engine (`main-engine-claude`) and `mirrorUserConfig` on the Codex main engine (`main-engine-codex`) are removed.

## Migration

1. Move any permission rules you relied on in `~/.claude/settings.json` or `~/.codex/config.toml` into the Harness session permission presets (`/permission`); host files no longer affect sessions.
2. Remove `permissionMode` and `settingSources` from `main-engine-claude` config and `mirrorUserConfig` from `main-engine-codex` config in `cordis.yml`; the loader rejects unknown keys.
3. Confirm: a workspace-write session auto-accepts file edits, a read-only session asks before any action, and a full-access session runs without approvals regardless of host configuration.
