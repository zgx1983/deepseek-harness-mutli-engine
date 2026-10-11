# Agent Note: external engine delivery settles as acknowledged-uncertain — the engine owns delivery truth

Status: implemented

English | [中文](2026-10-05-engine-delivery-auto-acknowledgement.zh.md)

## Problem

The durable delivery ledger (`engine/input-submitted` / `engine/turn-settled`) originally blocked every later prompt in an external engine session whenever a dispatched input lacked a terminal settlement: `EngineDeliveryUncertainError` demanded a manual `/engine-recover continue`. Two failure classes reached that gate constantly. A writer crash mid-turn always leaves a ledger gap, because the settlement writer shares the process that died — and `interruptedTurnClosers` repaired the turn lifecycle while the ledger stayed open, so a freshly repaired session still rejected all input. A user interrupt the engine did not acknowledge within its deadline reached the same gate. In both classes the mandated manual inspection changed no decision: every recovery path performs the identical next action — never resend, resume native history.

## Decision

**External engines own delivery truth.** The native session history is authoritative for whether a dispatched turn ran; the durable native binding recorded before the first dispatch, plus resume at preparation, reconstructs engine state. The ledger is an observational record that always settles: a dispatched input without a terminal native settlement is recorded as `outcome: 'acknowledged-uncertain'` by the failing turn itself (the external-turn failure path in `agent-loop`), and `acknowledgeUncertainEngineInputs` in engine-records acknowledges any crash residue at the start of every driver preparation. `/engine-recover`, `EngineDeliveryUncertainError`, and `assertSettledEngineInputs` are removed; `pendingEngineInputs` remains the ledger replay.

## Alternatives considered

- **Keep the manual gate for in-process failures and auto-acknowledge only crash residue** — rejected: the next action is identical in every path (close the dead adapter, resume native history), so the manual step stays zero-information.
- **Acknowledge inside crash repair (`interruptedTurnClosers`)** — rejected: driver preparation is the single choke point both engines already traverse, and repair callers would need the same ledger replay anyway.
- **Move the delivery ledger into each driver** — rejected: it duplicates durable state the session log already records, and the reader would lose one uniform ledger.

## Consequences

What was given up: the guarantee that a human inspected native history before a session continued after uncertain delivery. What holds: inputs are never resent (inbox consumption is durable and no replay path exists), the native binding still precedes first dispatch, and the ledger still records uncertainty so a transcript can mark turns whose outcome lives only in native history. Sessions poisoned by a mid-turn crash accept input again on the next prompt. Verification: the delivery-ledger unit test in `packages/core/agent/tests/engines.spec.ts`, the acknowledged-uncertain settlement test in `packages/core/agent-loop/tests/external-context.spec.ts`, and the engine and session-controller suites. The command removal is covered by the `engine-recover-command-removed` upgrade guide.
