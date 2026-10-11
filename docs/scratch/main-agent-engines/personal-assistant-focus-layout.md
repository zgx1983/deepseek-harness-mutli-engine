# Personal assistant focus and task-section interaction design

English | [中文](personal-assistant-focus-layout.zh.md)

## Table of contents

- [Scope and related design](#section-1)
- [Current focus in the middle column](#section-2)
- [Sidebar information order](#section-3)
- [Wireframe](#section-4)
- [Cards and state-specific details](#section-5)
- [Interaction, adaptation and feedback](#section-6)
- [UI acceptance and scope constraints](#section-7)

<a id="section-1"></a>

## Scope and related design

Status: superseded for the middle-column focus strip. The conversation keeps its full independent area; the right-sidebar task sections remain the current design. Date: 2026-10-07. This document records the original layout proposal, not backend transitions, scheduling, APIs or migrations.

Retain left navigation, middle conversation and shared right sidebar. Add compact Current focus above the conversation and organize the sidebar as Running, Awaiting confirmation, To do and History. This replaces the default overview organization in the [task workspace design](personal-assistant-task-center.md). Its parent/child, complete-list, history-search and pagination design remains a related reference; this proposal does not claim acceptance on every platform.

Users should quickly find ongoing work, results needing confirmation and next actions while conversation/input remain usable. Actual cancellation, failure and approval semantics belong to implementation; UI labels do not change business state.

<a id="section-2"></a>

## Current focus in the middle column

Add a compact two/three-line region above conversation: focused title/state, latest reliable summary and View task. Target content height is at most 15% of usable middle-column height, about 64–96 px in ordinary windows; implementation uses shared sizing tokens or presentation preferences. Summaries stop at two lines, with longer content in details rather than unbounded growth.

Focus this task in sidebar details pins the selection. Browsing another task or polling does not replace it. One parent can be focused, with an active-child hint. Provide Clear focus and collapse; collapsed form retains a single title/state/action line. Completion retains a result notice until the user inspects or clears it, without automatically selecting another task.

Without a focus, show a short count summary such as two running and three awaiting confirmation. Counts locate the corresponding sidebar sections. No tasks yields a compact creation entry. Do not add full lists, calendars or large charts, and do not automatically call the model.

Short windows prefer the single-line form. Conversation uses remaining space with independently scrolling messages and a visible composer. Reuse conversation components and keep essential permissions/stop controls accessible. Persist focus/collapse per assistant identity rather than across unrelated stores.

<a id="section-3"></a>

## Sidebar information order

| Order | Section | Default content | Primary action |
|---|---|---|---|
| 1 | Running | Current work, latest progress, child summary and issues. | View progress. |
| 2 | Awaiting confirmation | Result summary, ending time and user decisions. | View result. |
| 3 | To do | Objective, eligibility and dependency/configuration blockers. | View task / Start. |
| 4 | History | Entry to accepted/cancelled tasks. | View history. |

Keep My tasks, creation and search at the top. The first three groups share one main scroll area, have collapsible counted headers and retain preferences. Initially show up to three parents per group with View all and totals, controlled by presentation configuration. Children appear through summaries/details rather than unrelated root cards.

Ended executions with unconfirmed results are prominent in Awaiting confirmation; accepted results appear in History. Classification uses reliable task/result records, not completion claims in conversation.

Parents with active children appear in Running; without active execution but with reviewable results, in Awaiting confirmation; other active parents appear in To do. Each parent occurs once in the default view, with review/action badges exposing other concerns. Display sections may differ from the parent business state without fabricating transitions.

Failures are not hidden in History: active parents emphasize them in progress cards; otherwise To do places them first as Needs action. Available confirmation/retry follows actual capabilities; failed execution never offers false completion acceptance. Empty groups use compact headers/notices rather than large gaps.

<a id="section-4"></a>

## Wireframe

The wireframe is illustrative rather than actual tasks or implemented behavior.

```text
中栏                                    右侧 · 我的任务     ＋任务 搜索
┌ 当前关注                    收起 ┐    正在运行 2                   ▾
│ 整理项目文档 · 执行中             │    ┌ 整理项目文档 · 执行中       ┐
│ 正在补充使用示例   [查看任务]     │    │ 子任务 2/5 · 1 项待确认     │
├──────────────────────────────────┤    │ 最近进展：补充使用示例      │
│                                  │    │ [查看进展]              ⋯   │
│             助理对话             │    └────────────────────────────┘
│                                  │    等待确认 3                   ▾
│                                  │    ┌ 检查配置兼容性              ┐
│                                  │    │ 发现 2 处需要调整的配置      │
│                                  │    │ [查看结果]                  │
│                                  │    └────────────────────────────┘
│                                  │    待办任务 6                   ▾
│                                  │      ○ 整理发布说明 · 可开始
├──────────────────────────────────┤      ○ 完整构建 · 等待文档任务
│ 输入消息……                       │                  查看全部 6 项 →
└──────────────────────────────────┘    历史任务          查看历史 →
```

History is an entry rather than a large ended-task feed. Execution activity belongs in details rather than a fifth peer section.

<a id="section-5"></a>

## Cards and state-specific details

Running cards emphasize progress: title, state, active-child summary, observed duration and View progress. Without reliable phases, show Running rather than invented steps/percentages. Confirmation cards emphasize outputs/decisions instead of process. To-do rows show objectives/blockers, with full plans on expansion.

Cards open details in the existing sidebar, not a fourth persistent column. Back to Running/Awaiting confirmation/To do preserves source position. View all opens filtered complete lists; search/history open paginated lists and preserve filters/page on return rather than embedding everything in overview.

| Type | Primary detail content | Subsequent content |
|---|---|---|
| Running | Progress, active children and issues. | Complete children, results and attempts. |
| Awaiting confirmation | Summary, outputs and decisions. | Child results, execution and history. |
| To do | Objective, child plan and start conditions. | Description, dependencies and previous attempts. |
| History | Final results and acceptance. | Children and execution attempts. |

Parents summarize child states; collapsible child rows expose descriptions, prerequisites, errors, results and attempts. Large child collections use filters and paging/load-more. Review identifies the exact parent/child; accepting a child does not imply parent-wide acceptance.

Acceptance sits in result details so inspection precedes confirmation rather than accidental list clicks. Missing results/summaries are explicit, never fabricated. Stop/cancel/retry belongs in details or overflow; parent cancellation explains its affected scope.

<a id="section-6"></a>

## Interaction, adaptation and feedback

Middle focus and sidebar selection are independent. View task opens/locates sidebar details; pinning never sends messages. Ask about task pastes a visible reference into a draft for user submission. Refresh never steals input/cursor.

Section changes do not abruptly unmount cards under interaction. A lightweight update notice precedes safe refresh/reordering or return navigation. Review counts may update without stealing focus or expanding groups. Details retain source navigation and expose current state when the task no longer matches its source section.

Narrow cards use one column with wrapping metadata; wider containers add summary/time columns. Adapt to sidebar container width. Short middle columns collapse focus to one line, and pagination wraps while remaining reachable. Avoid nested permanent card/group/list scroll regions.

Reuse shared components, themes and typography with new weights at most 500. States use text/icons as well as color. Collapse exposes aria-expanded; menus dismiss via Escape/outside click, detail navigation restores focus and motion respects user preferences. Copy uses bilingual dictionaries and both themes are checked.

Shared skeletons serve first load; refresh retains content. Query failures have local retries; operations retain tasks and use shared Toast. No tasks, no matches, no history and unavailable results have distinct clear empty states.

<a id="section-7"></a>

## UI acceptance and scope constraints

Acceptance covers usable conversation/composer in normal/short windows; bounded two/three-line focus and single-line collapse; stable pinning; clear sidebar order/counts; no repeated parents; visible child review/failure during execution; inspect/accept paths; visible blockers; paginated history without overview crowding; restored navigation and refresh preserving drafts/focus/preferences.

Verify Web/Desktop, locales, themes and keyboards with narrow/wide sidebars, long titles, many children, empty tasks, failures, missing results and refreshes. Select component and real-UI checks during implementation; wireframes never replace acceptance.

This iteration saves UI design only, changing no code and prescribing no new backend APIs/states. Update implementation status in the [feature list](../../../worktree-feature-list.md), without marking completion before verification.
