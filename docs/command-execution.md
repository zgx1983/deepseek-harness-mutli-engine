# Command execution and feedback standard

English | [中文](command-execution.zh.md)

## Summary

Agents, command wrappers and other tools in this project follow the same feedback rules: keep complete operation logs at the executor, return short success summaries, return bounded failure diagnostics, and return data needed by the task for queries. Wait for completion or meaningful state changes instead of repeatedly reading unchanged output. Explicit user requests for full output take precedence.

## Table of contents

- [Scope and output modes](#scope)
- [Execution and waiting](#waiting)
- [Success expectations and summaries](#results)
- [Failure diagnostics and log reads](#diagnostics)
- [Log retention and sensitive information](#logs)
- [Tool responsibilities and current entry points](#tools)
- [Execution checklist](#checklist)

<a id="scope"></a>
## Scope and output modes

This standard covers builds, tests, lint, type checks, documentation generation and validation, dependency installation, packaging, startup checks and other operation commands, as well as agent reads of their results. Feedback depends on the task's purpose, not the command name or exit code. A command may produce both operation logs and task-required data.

| Mode | Use | Content returned to the model |
|---|---|---|
| Summary | Builds, checks, installation, documentation generation and similar operations | Terminal state, duration, required statistics, expectation checks, artifacts and log location |
| Data | Branch listings, source reads, configuration queries and information extraction | Task-relevant data; filter, paginate or expose readable resources for large results |
| Interactive/streaming | Commands requiring input, service startup and ongoing processes | Required prompts, readiness or meaningful state changes; routine progress and duplicate output remain in logs |

Do not hide source, configuration, query results or document content required by the task merely because the command succeeded. Diagnostics are not query data; reading a file does not require returning an entire directory or repository. Narrow files, search scope and fields first, and batch independent necessary queries.

<a id="waiting"></a>
## Execution and waiting

Determine log location and success expectations before starting an operation. Save stdout and stderr to a unique log or executor-accessible resource instead of sending everything to model context before summarizing. Preserve real exit codes, signals, cancellation and startup exceptions; redirects or pipelines must not accidentally report the last helper command's status.

Prefer process sessions, completion events or status waits supplied by tools. Do not repeatedly read log tails to determine completion or reread already delivered fragments. Where polling is necessary, inspect running status at reasonable intervals; read relevant output only for a new phase, failure, abnormal stall or required input. User updates for long operations may describe continued execution and known phases without passing routine logs to the model. Wait lengths follow the agent environment's communication and interruption requirements.

Stop reading when results suffice: do not reopen successful logs after expectations are met, or browse unrelated logs when failure evidence already supports a repair. Status requests during a task should not trigger duplicate checks, repeated commands or additional full-log reads. Rerun checks only when new edits, failures, anomalies or unmet expectations require it.

Distinguish process existence, service readiness and completion for persistent processes. Accept startup through the specified readiness probe rather than treating continued execution as success or waiting for a long-running service to exit. Subsequent output stays in logs; report service failures, readiness failures and required state changes separately.

<a id="results"></a>
## Success expectations and summaries

A zero exit code is one necessary piece of evidence for successful operations, not a replacement for task requirements. Checks satisfy verifiable expectations declared by project configuration, tools or the task; do not lower them afterwards to claim success. Different commands need different checks, and the policy does not expand the original check scope.

| Operation | Example expectations |
|---|---|
| Tests | Selected projects actually match, expected tests run, failures are zero, and permitted skips are reported |
| Builds | Required artifacts exist and belong to this valid build or verified reuse; required smokes are reported separately |
| Documentation generation/updates | Required files exist and declared synchronization or pairing checks pass; failing validation is not hidden |
| Installation/packaging | Required packages or archives exist with the intended target and version |
| Service startup | Readiness probe succeeds and the address or entry point is identified |

Report no matching projects, no tests executed, missing artifacts or unintended skipped checks as unmet expectations even when exit code is zero. If expectations cannot be verified, say unverified rather than passed. One passing check does not establish feature acceptance, all tests passing or deployment completion.

Success summaries include operation and scope, terminal state, duration, required statistics, expectation checks, necessary artifacts and log location. Omit unavailable fields or mark them unknown; never invent counts or durations. Retain per-check states, expanding only failures or unmet expectations in multi-command summaries while still reporting cancellations and required skip information.

The following is a proposed common result-field convention, not a JSON interface already implemented by every tool. Equivalent concise text is acceptable without waiting for a tool migration. Distinguish running, ready, passed, failed, cancelled and unmet-expectation; readiness applies only to persistent processes, and unmet expectations preserve the real exit code.

```json
{
  "operation": "unit-tests",
  "scope": "personal-assistant",
  "status": "passed",
  "exitCode": 0,
  "durationMs": 1200,
  "summary": { "passed": 28, "failed": 0, "skipped": 0 },
  "expectations": { "status": "satisfied" },
  "artifacts": [],
  "logPath": "/absolute/path/to/run.log",
  "diagnostics": []
}
```

<a id="diagnostics"></a>
## Failure diagnostics and log reads

Initial failure feedback includes operation, scope, real exit state, failed items, log location and enough diagnostics to locate the problem. Default fragments contain at most 80 lines and 12000 bytes, matching the current quiet wrapper's limits; prefer shorter directly relevant fragments. Preserve locations, error codes, key messages and required stack frames. A tail alone must not be presented as an established root cause.

When evidence is insufficient, search saved logs by failed check, package, file, error code or stage, then read bounded context around matches. Each read answers a concrete diagnostic question rather than returning a full cat, a large tail or a repeated fragment. Narrow or paginate large results. Expand the scope only when the complete content is required by the task or explicitly requested by the user.

Report compiler errors, test failures, unmet expectations and environment restrictions separately. Handle credentials, network, IPC or other host-sandbox failures through the existing root AGENTS.md retry rules. Trimming diagnostics must not hide failures, bypass product confinement, disable checks or silently rerun away the real result. Cancellation remains cancelled rather than success or an ordinary failure.

<a id="logs"></a>
## Log retention and sensitive information

Each execution uses a unique log location so concurrent runs cannot overwrite each other. Repository logs belong in Git-ignored directories. `.dsh-build/build-logs/` is the current root wrapper's directory; other tools use appropriate ignored directories or execution resources. Report an absolute path or resource identifier and retain logs until investigation ends. Tool policies and user requests determine deletion or retention periods; never delete another task's logs.

Writing logs does not redact them. Avoid logging credentials or unnecessary private content; remove unrelated sensitive values before returning required diagnostics to the model. Full-output requests do not override existing credential protections. Retain diagnostic file locations, line numbers, error types and required context rather than erasing the error entirely.

<a id="tools"></a>
## Tool responsibilities and current entry points

| Layer | Responsibility |
|---|---|
| Execution tool/wrapper | Log persistence, process waits, exit/signal/cancellation, duration, diagnostic limits and resource locations |
| Command adapter | Extract test statistics, compiler errors, generated artifacts and check states; parsing failures never fabricate structured results |
| Project/task configuration | Declare commands, scope, required artifacts, readiness and permitted skip conditions |
| Agent | Choose summary/data/interactive mode, read only necessary results and report actual checks and limitations |

Existing root scripts can save output through `pnpm run build:quiet -- <script> [arguments]`, used by `build:local` and available for other finite root package scripts. Daily build entry points and current wrapper behavior belong to [Daily local builds](cookbook/local-builds.md). The wrapper currently returns exit state, duration, log location and a bounded failure tail; it does not automatically extract test statistics or verify every success expectation, which remains the caller's responsibility.

This policy adds no run:quiet command and does not claim every tool is already adapted automatically. Commands outside the root wrapper use equivalent file/resource output and preserve exit state; persistent processes save output and supply readiness probes; queries return required data. New tools and subsequent adaptations follow the same rules without defining a separate logging policy for each feature.

<a id="checklist"></a>
## Execution checklist

1. Determine whether the task needs an operation summary, query data or interactive output, and select the smallest required scope.
2. Save operation logs at the executor and wait for completion or meaningful state changes.
3. Check real exit state and applicable expectations, distinguishing pass, failure, cancellation and unmet expectations.
4. Receive only summaries on success and bounded diagnostics on failure; read targeted evidence only if needed.
5. Stop reading and rerunning once results suffice, then report scope, results and necessary log locations.
