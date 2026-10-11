# Daily local builds

English | [中文](local-builds.zh.md)

## Build both applications together

Use `pnpm run build:local` for ordinary iterations. It produces a coordinated set of Web, Desktop, workspace dependency and local plugin artifacts. There is no application or face selector: unchanged artifacts are reused only after content verification, and changed workspace packages include all transitive consumers declared in dependency, development, peer and optional dependency sections. TypeScript retains its incremental project information; tsdown bundles only affected workspace packages. Web and Desktop are rebuilt after runtime input changes, and every local plugin with a `build.mjs` entry is refreshed because its browser bundle may inline shared code. The Desktop development project is created or refreshed for launchers such as `dsh-start`, including when unchanged build artifacts are reused.

| Situation | Command | Behavior |
|---|---|---|
| Ordinary iteration | `pnpm run build:local` | Detect changed inputs, rebuild dependencies and both applications, reuse verified unchanged artifacts. |
| Force a fresh coordinated baseline | `pnpm run build:local -- --full` | Complete repository build, local plugin builds and final Desktop build. |
| Official client build profile | `pnpm run build:local -- --profile official` | Coordinate artifacts with the selected public client environment; a changed environment requires a complete baseline. |

The first run performs a complete baseline build. Incremental Client builds select both the package library and its `/client` browser bundle. Missing or modified artifacts, dependency or root compiler configuration changes, native changes, shared bundler changes, build script changes and runtime or public client environment changes invalidate the baseline. A deleted package also invalidates it. If no build inputs changed and artifact hashes still match, both applications reuse the previous successful artifacts. The cache lives in `.dsh-build/local-build.json`, is local and disposable, and is saved only after every stage succeeds. Failed stages prevent later stages and discard the cache. Inputs changed during a build prevent acceptance; rerun after editing stops. The complete client artifact record is written only when the coordinated build has succeeded.

Stop rebuild watchers and other builders before running the coordinated build. Do not run `clean` between ordinary iterations. Do not edit the cache to bypass validation. This command does not package installers, change user profiles, start services, or replace the behavior tests and Session snapshots required by a feature. Desktop preparation reuses the shared Electron cache; first use may download Electron. It prepares workspace links and release metadata without starting Electron or preparing the primary interpreter runtime. Native build failures remain failures; a package with incorrectly declared build dependencies still needs its manifest fixed. The legacy face-specific build commands remain available for diagnosis, but are not the daily coordinated build workflow. See [development commands](../development.md) for application startup.

## Keep output small

All build tools follow the project [command execution and feedback standard](../command-execution.md). The following describes the current wrapper's output and build-specific expectations.

`build:local` uses the `build:quiet` wrapper. Complete output goes to a unique file under `.dsh-build/build-logs/`, which Git ignores. Success prints only status, elapsed time and the absolute log path. Failure preserves the exit code and prints the last 80 lines within the last 12000 bytes. If the cause appears earlier, search the saved log and return only the relevant diagnostic to the agent. Inspect missing artifacts or failed smoke checks separately; compilation success alone does not make those checks pass.

`pnpm run build:quiet -- <script> [arguments]` also wraps other finite root package scripts without a shell. Capture long-running watcher output to a file; ordinary progress checks should read process status rather than repeatedly print the log tail. Keep logs until investigation is complete and remove old files when no longer needed. The wrapper does not filter secrets or change the scripts it invokes.

## Execution steps for agents

Use this workflow when the user requests Web, Desktop and dependency builds after daily iteration; run from the current repository root. Read the repository `AGENTS.md` first, preserve user changes and retain user data.

1. Finish source edits and stop build watchers started by this task; confirm no other builder or source writer is active. Do not terminate processes owned by other tasks.
2. Run `pnpm run build:local` and wait for completion. The first run automatically builds a complete baseline; use `--full` only when requested or when diagnosing cache problems.
3. On success, record only exit status, elapsed time and the log path; do not read or print the complete log. For long runs, check process status and give brief progress without repeatedly printing log tails.
4. On failure, stop acceptance and inspect the bounded diagnostics from the wrapper; if necessary, search that log for errors and read relevant context. Fix the cause and rerun the same entry. For sandbox permission failures, follow `AGENTS.md` and retry unchanged with the narrowest host escalation; do not skip failing stages.
5. After the command succeeds, perform artifact or runtime checks required by the task. Building does not start applications; launch through supported entries only when requested. Report checks actually run, failures and outstanding work; do not equate a successful build with feature acceptance.

A `source changed during the build` failure cannot establish a valid incremental baseline. Wait until source and build scripts are stable, then rerun. Never hand-write the cache or artifact record, and never substitute a standalone `build:web` or `build:desktop` for the coordinated build.

## Check scope

| Item | Included in the local build | Agent action |
|---|---|---|
| TypeScript compilation checks for affected projects | Yes | Any compilation error prevents success. |
| Web, Desktop, affected dependencies and local plugin builds | Yes | Produce consistent artifacts for both applications; do not finish only one. |
| Focused lint and behavior tests | No | Select relevant changed files; do not default to the full test suite. |
| Complete typecheck and lint | No | Select according to public API changes and repository rules; current scripts build Host first. |
| doc-sync, documentation pairing and link checks | No | Run according to documentation changes and retain complete logs in files. |
| Session snapshots, real-API tests and application smokes | No | Select by impact and task requirements; report results separately. |

Other finite root scripts can use `pnpm run build:quiet -- <script> [arguments]`, for example `pnpm run build:quiet -- doc-sync`. This wrapper reduces output, not check scope; quiet logs do not justify running expensive full checks by default.

## Current validation status

The coordinated baseline build has completed successfully. Eight focused tests covering quiet output, dependency propagation, compiler-face selection and Desktop development project preparation pass. Desktop preparation also succeeds with a previously missing project directory. Unchanged-input reuse and incremental rebuilding after real dependency edits remain unverified; agents must not claim verified incremental speed.
