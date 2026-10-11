# Agent Note: 外部引擎投递结算为 acknowledged-uncertain——投递真相归引擎所有

Status: implemented

[English](2026-10-05-engine-delivery-auto-acknowledgement.md) | 中文

## Problem

持久投递账本（`engine/input-submitted` / `engine/turn-settled`）最初的设计是：已派发的输入一旦缺少终端结算，外部引擎会话中的所有后续提示都会被阻断——`EngineDeliveryUncertainError` 要求人工执行 `/engine-recover continue`。实践中两类失败会持续命中这道闸。写入进程回合中途崩溃必然留下账本缺口，因为结算写入方与崩溃的进程同生命周期——而 `interruptedTurnClosers` 修复了回合生命周期、账本却保持敞开，导致刚修复完的会话依然拒绝所有输入。引擎未在时限内确认的用户中断也会命中同一道闸。在这两类场景中，强制的人工检查不改变任何决策：所有恢复路径执行完全相同的下一步——不重发、恢复原生历史。

## Decision

**外部引擎拥有投递真相。** 原生会话历史是"已派发的回合是否执行过"的权威记录；首次派发前落盘的持久原生绑定加上准备阶段的恢复即可重建引擎状态。账本降级为总是结算的观测记录：已派发但没有终端原生结算的输入，由失败回合自身（`agent-loop` 的外部回合失败路径）记录为 `outcome: 'acknowledged-uncertain'`，崩溃残留由 engine-records 中的 `acknowledgeUncertainEngineInputs` 在每次驱动器准备开始时补记。`/engine-recover`、`EngineDeliveryUncertainError`、`assertSettledEngineInputs` 均被移除；`pendingEngineInputs` 保留为账本重放。

## Alternatives considered

- **进程内失败保留人工闸门、仅对崩溃残留自动确认** —— 否决：每条路径的下一步动作完全相同（关闭失效适配器、恢复原生历史），人工步骤始终是零信息量的。
- **在崩溃修复（`interruptedTurnClosers`）内确认** —— 否决：驱动器准备是两个引擎都已经过的唯一收口点，修复调用方同样需要账本重放。
- **把投递账本移进各驱动器** —— 否决：这会复制会话日志已经记录的持久状态，读取方也会失去统一的账本。

## Consequences

放弃的东西：不确定投递后继续会话之前，不再保证有人检查过原生历史。保持的东西：输入绝不重发（收件箱消费是持久的，不存在重放路径）、原生绑定仍先于首次派发落盘、账本仍记录不确定性，转写得以标记那些结果只存在于原生历史中的回合。回合中途崩溃而中毒的会话在下一次提示时即可恢复接受输入。验证：`packages/core/agent/tests/engines.spec.ts` 的投递账本单元测试、`packages/core/agent-loop/tests/external-context.spec.ts` 的 acknowledged-uncertain 结算测试，以及引擎与 session-controller 套件。命令移除由 `engine-recover-command-removed` 升级指南覆盖。
