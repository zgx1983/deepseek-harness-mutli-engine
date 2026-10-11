# dsh-recent-sessions

English | [中文](README.zh.md)

## Recent section

A client-only plugin filling the sidebar shell's `sidebar.recent` seat with the Recent section: a parallel block above the Workspace browser listing unread (pending interaction or unviewed completion), running, and today's sessions, in that priority order. Each bucket orders by last update, newest first; the first seven rows show with an expand/collapse control for the rest, and the section header folds the whole list. Personal Assistant task execution Sessions qualify like any other Session; only the assistant's resident conversation stays out, through catalog exclusion. A row names its owning Workspace before the session title (`project/title`), keeping the Workspace's leading characters when the name is too long. The collapsed rail renders nothing.

Blank (provisional New Session), archived, and subagent sessions never qualify — a delegated child's only entry is the parent conversation's subagent panel. Sessions hidden from the catalog (for example the personal assistant's fixed conversation) never qualify either, because catalog exclusions remove them from the Host list this projection reads. Opening a row navigates through the shared `uiWorkspace` service.

The plugin registers its occupant through `slots.inject`, so activation order against the ui-sidebar shell is unconstrained. The shell declares the seat; this plugin is its only occupant.

## Configuration and loading

The package root exports a Host loader entry with no Host behavior; `./client` supplies the browser bundle. Its client injection list includes ui-primitives for icons, state dots and relative times.

No configuration. Build from the repository with `node plugins/dsh-recent-sessions/build.mjs`, then pack and install through the profile plugin manager. The bundle enables only `ui-recent-sessions`. The `sidebar.recent` seat must exist in the running ui-sidebar build; against a build without it the registration fails loud at load.

## File and function map

| File | Function |
|---|---|
| `src/index.js` | `apply` provides the Host loader entry without Host behavior |
| `src/client.jsx` | `apply` registers dictionaries, styles, and the `sidebar.recent` occupant; `RecentSessions` renders the section |
| `src/recent.js` | `deriveRecentSessions` projects the qualifying rows and the collapsed hidden count |
| `src/locales.js`, `src/css.js` | Localized copy and section styles |
| `cordis.patch.yml`, `build.mjs` | Activation settings and the ModuleLoader client bundle |
