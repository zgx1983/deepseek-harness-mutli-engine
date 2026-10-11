# Agent Note: engine sessions load the host's instruction files like the native CLIs

Status: implemented

English | [中文](2026-10-02-engine-native-instruction-loading.zh.md)

## Problem

The Claude and Codex main engines isolated sessions from the host's instruction files. The Claude engine passed `settingSources: []` to the Agent SDK (disabling every CLAUDE.md tier) and redirected `CLAUDE_CONFIG_DIR` into the Harness home, so neither `~/.claude/CLAUDE.md` nor the workspace's CLAUDE.md/AGENTS.md reached the model. The Codex engine redirected `CODEX_HOME` to a per-session hashed home, so the global `~/.codex/AGENTS.md` never loaded, while project AGENTS.md files (workspace-relative) still did. A task that behaves one way in a hand-run CLI behaved differently inside the Harness, and user/deployment guidance written for the CLI silently vanished.

## Decision

**Default both main engines to the native CLI's instruction loading, keeping storage isolation.** The Claude engine's deployment config gains `settingSources` defaulting to all three tiers (the CLI's own behavior), replacing the hardcoded `[]` in the main adapter; because `CLAUDE_CONFIG_DIR` stays redirected for settings, credential, and session isolation, the engine mirrors the host's `~/.claude/CLAUDE.md` into that home before startup whenever `user` is among the resolved sources. The Codex engine mirrors the host's `~/.codex/AGENTS.md` into the per-session `CODEX_HOME` on every preparation, so the native global-instructions lookup reads it; deployment `mirrorUserInstructions: false` disables the mirror. Mirrors refresh content on every engine preparation and are removed when the source file disappears, so edits and deletions propagate.

## Alternatives considered

- **Point both engines at the real `~/.claude` / `~/.codex` homes** — rejected: sessions, transcripts, auto-memory, and settings would mix with the user's own CLI state in both directions, defeating the engine-owned storage that resume and credential isolation rely on.
- **Inject the file contents through a system-prompt append channel** — rejected: it bypasses each CLI's own loading semantics (Claude's `@import` resolution, tier framing) and would drift per engine.
- **Keep full isolation by default behind an opt-in flag** — rejected: the engines exist to reproduce CLI execution, and instruction files are the CLI's documented context channel; a deployment that needs isolation narrows `settingSources` or disables the mirror explicitly.

## Consequences

The `project` and `local` tiers are not splittable: with them enabled, repository settings, skills, and hooks also load exactly as the native CLI, and hooks run native commands outside the Harness `canUseTool` gating — the same exposure as running the CLI by hand, recorded here as accepted for parity. A `@import` inside a user CLAUDE.md resolves relative to the mirrored copy in the engine home, not the original directory. The mirror is a content copy (not a symlink) so it works on Windows without elevation; it is rewritten only when content differs.

## Related

- [Session engine selection](../architecture/2026-09-29-session-engine-selection.md) — the engines this loading behavior belongs to.
