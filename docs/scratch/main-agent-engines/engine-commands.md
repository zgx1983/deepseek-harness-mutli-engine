# Claude / Codex and Agent Team command support plan

English | [中文](engine-commands.zh.md)

## Summary

This plan adds a shared `/` command entry in main Sessions and continuable Agent Team child Sessions, with each engine executing commands through its own SDK or app-server operations. Implemented on 2026-10-04: Claude exposes `/plan` through dynamic `setPermissionMode`, Codex exposes `/plan` through native collaboration modes carried on every turn, and continuable Team children receive engine-only command directories. Implemented on 2026-10-05: the process-wide host permission snapshot and its per-session mirroring. The public package documentation owns the current behavior; this document records the plan and the version-verification findings.

## Contents

- [Current issues](#current)
- [Engine adapters](#engines)
- [Agent Team child Sessions](#team)
- [Engine permission configuration initialization](#permission-config)
- [Engine mapping for the three permission options](#permission-mapping)
- [Delivery and acceptance](#acceptance)
- [Dev Note](#notes)

<a id="current"></a>

## Current issues

The [client command service](../../../packages/client/ui-commands/src/client/service.ts) returned an empty command directory for Sessions with a subagent address, preventing commands after opening a Team member. External-engine commands in main Sessions also depended on the registered directory; input was rejected when `/plan` was absent.

The [Claude driver](../../../packages/subagent/subagent-claude-code/src/engine.ts) read prompt commands from the SDK but did not integrate dynamic permission-mode switching. The [Codex driver](../../../packages/subagent/subagent-codex/src/engine.ts) provided compaction, review, and discovered skills but did not integrate planning-mode switching.

<a id="engines"></a>

## Engine adapters

Commands are distinguished as prompt commands, control operations, and Session lifecycle operations. The directory lists only commands the current engine can execute; control operations do not depend on the native prompt-command directory and are not sent as ordinary messages.

| Operation | Claude | Codex |
|---|---|---|
| Command directory | SDK `supportedCommands()`, supplemented by the adapter `/plan` control command | Adapter-registered app-server operations, discovered skills, and `/plan` when the native collaboration-mode surface is present |
| Prompts and operations | SDK-supported prompt commands; lifecycle commands handled separately | Compaction maps to its operation, review to `review/start`, and skills use the existing invocation path |
| Enter planning mode | `setPermissionMode('plan')` on the live Query | Record the native collaboration mode and carry `{ mode: 'plan', settings: { model, reasoningEffort? } }` on every subsequent `turn/start` |
| Exit planning mode | Restore the permission mode active before planning (`default` when delegated) | Carry collaboration mode `default` |
| Effective timing | SDK switches dynamically, affecting subsequent permission handling | Applies from the next turn; the mode is a per-turn `turn/start` parameter |

The installed Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.263) supports `setPermissionMode` on the long-lived streaming-input Query, so the dynamic switch is verified against the dependency. The desired Session mode is recorded as an `engine/item-settled` record with category `mode`, re-applied when the adapter prepares, and folded into the shared `plan` projection so the existing plan indicator shows engine modes after the engine acknowledges the switch.

The shipped Codex 0.153.4 binary was verified directly (static strings plus live app-server probes), and it differs from the `rust-v0.153.4` GitHub tag schema: the binary's `TurnStartParams` accepts a `collaborationMode` field (24 fields, not 16), `collaborationMode/list` returns the `Plan` and `Default` presets, and `turn/settings/update` does not carry modes. `turn/start` validates `collaborationMode` as `{ mode, settings: { model, reasoningEffort? } }`. The driver therefore registers `/plan` only when `collaborationMode/list` succeeds and reports an explicit unsupported reason otherwise.

<a id="permission-config"></a>

## Engine permission configuration initialization

The proposal reads and validates host engine permission configuration when Harness starts, producing a process-wide read-only snapshot. When each main Session or Team child starts, it applies that snapshot to the Session's isolated engine directory, then combines it with that Session's selected permission preset to derive startup parameters. Codex's native runtime continues to parse `.rules` contents.

| Engine | Initialization read | Apply at each Session start |
|---|---|---|
| Claude | The `permissions` section of `~/.claude/settings.json` | Write it to the Session's `CLAUDE_CONFIG_DIR/settings.json`; retain or clear it according to the selected permission policy; native sources continue loading project and local settings |
| Codex | Supported permission fields in `~/.codex/config.toml` and `~/.codex/rules/*.rules` | Mirror config fields and rule files into that Session's `CODEX_HOME`; Codex performs rule parsing |

The process-wide snapshot fixes only native configuration. `/permission` selection and derived engine parameters remain Session-specific, so Sessions can choose different levels. Host configuration keeps snapshot semantics while Harness runs: external file edits apply after Harness restarts. This proposal does not include refreshing the process-wide snapshot at runtime.

Implemented as proposed: engine registration reads and validates the host configuration into the process-wide snapshot — Claude snapshots the `permissions` section of `~/.claude/settings.json`; Codex snapshots the supported permission fields of `config.toml` plus every `rules/*.rules` file verbatim, leaving rule parsing to the native runtime. Each Session preparation applies the snapshot to its engine directory — Claude writes `CLAUDE_CONFIG_DIR/settings.json` and clears it for full access; Codex mirrors the config fields and rule files into `CODEX_HOME` and removes them for full access. Host file edits enter the snapshot only after Harness restarts.

<a id="team"></a>

## Agent Team child Sessions

Opening a member retains existing child-Session navigation and input components. Continuable members fetch their own command directories and show candidates for their engines; one-shot tasks and unrecoverable Sessions keep an empty directory.

Command requests carry the current child Session ID and obtain its engine through the existing subagent lifecycle management in the [Session command controller](../../../packages/api/session-controller/src/commands.ts). Planning, compaction, review, and skill operations target only that member and never fall back to the Lead. The parent Session must satisfy existing borrowing and recovery requirements. Child directories carry engine commands only; Host-registry commands such as `/model` remain main-session commands.

Modes, command-directory caches, and acknowledgment states are maintained separately for each child Session. Member navigation, engine recovery, or command-directory changes update the corresponding directory. Opening a member does not send a prompt automatically; command queries that require engine preparation follow existing lifecycle rules. Closed, disconnected, unrecoverable, or unsupported operations return explicit reasons.

<a id="permission-mapping"></a>

## Engine mapping for the three permission options

The permission selector continues to represent three user-facing levels. At engine startup, the selected level for the current Session maps to native Claude or Codex parameters. Workspace modification uses each engine's own permission configuration; full access explicitly removes ordinary sandbox and approval restrictions.

| Option | Claude startup mapping | Codex startup mapping |
|---|---|---|
| Read-only | Enable the read-only sandbox and restrict file writes; route other tool requests that need permission to DSH approval, allowing them only when the native engine can execute the approved temporary grant | `sandbox: 'read-only'`, `approvalPolicy: 'on-request'`; route other operations that need permission to Codex approval and provide temporary permissions through its native protocol after approval |
| Workspace modification | Preserve native permission rules in Claude `settings.json` and load user, project, and local settings; do not override these rules with DSH defaults | Preserve Codex `config.toml` permission fields and `rules/*.rules`; do not override native configuration with DSH defaults |
| Full access | `permissionMode: 'bypassPermissions'`; disable the Harness-configured sandbox and ordinary approval; clear host permission rules mirrored into the isolated directory | `sandbox: 'danger-full-access'`, `approvalPolicy: 'never'`; do not apply permission overrides from host configuration |

Read-only remains subject to native engine deny rules and operating-system sandbox restrictions; DSH approval cannot override a native deny. The effective reach of full-access mappings also follows native hard-deny rules for each engine. Verify those rules separately during acceptance instead of inferring behavior from the mode name.

**This phase includes permission changes in an existing Session.** Both the conversation permission dropdown and `/permission <preset>` call the same Harness command and update the current Session preset. If the selection changes engine startup parameters, the active turn finishes first; Harness then restarts that Session engine at the next preparation, resumes the same native conversation, and starts with the new parameters. Claude applies the mode and sandbox through a new Query; Codex applies permissions through sandbox and approval parameters when resuming its thread. The new level takes effect on the next turn after restart.

This phase does not change permissions in the middle of an active turn or refresh the process-wide host configuration snapshot at runtime. `/permission` changes only the Session selection and does not reread host files; external edits to Claude `settings.json` or Codex `config.toml` and `rules/*.rules` enter the new global snapshot after Harness restarts.

<a id="acceptance"></a>

## Delivery and acceptance

Implementation first verifies native permission behavior, initializes the process-wide configuration snapshot and mirrors it into Session directories, derives engine startup parameters for the three levels, connects the dropdown and `/permission` Session update to restart-and-resume on the next turn, then updates the feature checklist.

- Cover main / Team child Sessions and Claude / Codex combinations, verifying directories, execution, and unsupported-command feedback.
- Verify that changing permission in an existing Session lets the active turn finish, restarts the target engine, resumes its native conversation, and applies the new level on later turns without affecting other Sessions.
- Verify that commands target the selected member without affecting the Lead or other members, and that navigation does not mix directories or state.
- Verify host permission files enter a new snapshot after Harness restarts; `/permission` does not unexpectedly refresh global configuration, and invalid or unsupported native settings fail explicitly.
- Verify failure feedback for closed Sessions, unrecoverable members, unavailable parents, and one-shot tasks.
- Verify compaction, review, and prompt or skill arguments. Keyless recorded-session snapshots are unaffected: no SessionEventMap member changed.
- Mode state is reconstructable from the Session log through `engine/item-settled` category `mode`; no declared persistence type changed, and the `plan` projection bumps its state version so caches rebuild from the log.

<a id="notes"></a>

## Dev Note

Implemented 2026-10-04, with the permission snapshot initialization and mirroring on 2026-10-05. The Codex findings above come from the shipped 0.153.4 binary, not the GitHub tag; re-verify against the binary whenever the pinned Codex version changes.
