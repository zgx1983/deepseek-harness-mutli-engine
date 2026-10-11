# Agent Note: the closed Desktop sidebar previews over the conversation

Status: implemented

English | [中文](2026-10-09-sidebar-hover-preview.zh.md)

## Problem

A collapsed sidebar on macOS and Windows desktop keeps no rail: `AppFrame` solves the closed column to zero width and moves the reopen controls into the window chrome. Reaching the workspace browser, the recent-sessions section, or the global panel list therefore requires a real expansion, which changes the grid track, reflows the centre, and animates the columns — a full layout transition for a look at what is behind the edge. The Web layout has no such gap because its closed sidebar keeps the 56px icon rail. [The macOS hidden-titlebar Agent Note](2026-09-13-macos-hidden-titlebar-vibrancy.md) owns the collapse and the `shell.leading` seat this preview opens from.

## Decision

**The frame owns the preview; the sidebar only re-reads its `wide` flag.** `sidebarPeeking` sits in the layout store beside `narrowExpanded`, because both are frame presentation states rather than user preferences. `AppFrame` derives `peekEligible` from `collapsedWidth === 0`, so Web never previews, and passes `peeking` plus `SIDEBAR_DEFAULT` as the sidebar's owner width. `SidebarRoot` maps `peeking` onto `wide`, draws at the supplied width instead of its frozen last-expanded width, and stays out of the collapse crossfade.

**The preview presents the one existing column instead of a second one.** The column stays a grid item inside its collapsed zero-width track and only draws wider than it: AppFrame gives the column the inline preview width and AppFrame.module.css lifts it (`position: relative`, layer 17) over the centre. The right column's anchored absolute panel does not transfer here, because an absolutely positioned column leaves the grid flow and the centre column then auto-places into the collapsed zero-width track, blanking the conversation. The preview takes no track and writes no width preference: the grid template, the centre's width, and every row marked `data-window-drag` stay exactly where they are, so Electron's geometry-composed drag regions never change and the shell's drag-recall pulse stays idle. The fill becomes opaque `--dsw-alias-bg-base` with `--dsw-elevation-panel` separation rather than a blurred translucent one, because a filtered ancestor would capture the fixed-position Settings panel that this column hosts.

**Layer 17** places the panel above the `shell.leading` controls (15) it replaces and below `shell.overlay` (20), so menus, toasts, dialogs, and the right panel's fullscreen presentation (40) keep their existing positions.

**The trigger is a dwell, and dismissal is a two-stage rule.** A pointer entering the left-edge strip (starting below `--dsh-frame-top-clearance`, so it never covers the traffic lights) or the `shell.leading` controls arms a 150ms timer that opens the preview only when `pointerModality()` reports pointer input and `modalSelector()` finds nothing on the top layer. Hover-out hides it 200ms later — `POINTER_GRACE_MS`'s hand-travel rationale — but the first press inside the panel stops the hover hide, and dismissal then takes a press outside through `useDismissOnOutsidePointer`. That split is required because the column's menus portal to `document.body` (`ui-workspace` row and search menus), so a hover-out cannot tell "crossing to my own menu" apart from "leaving the panel".

**Pressing the sidebar toggle while previewing commits the preview.** The store's `toggleSidebar` writes a real expansion when `sidebarPeeking` is set instead of toggling the preference blind, and the commit follows the existing rule that closing forgets the drag width, so the committed column is `SIDEBAR_DEFAULT`. `setSidebar`, a changed `setViewportWidth`, and `openRightbar` clear the preview; `closeRightbar` and panel selection do not.

## Alternatives considered

**A Factory occurrence of the sidebar column.** Independent render positions would need their own store handles and a second live workspace browser: two scroll positions, two expanded-directory sets, two directory-flow occupancies for one column nobody intends to duplicate.

**Absolutely positioning the previewed column to the frame's left edge, as the right column does with no track.** It removes the column from grid flow, so the centre takes the collapsed track and the conversation renders at zero width.

**Expanding the real track on hover.** Each dwell would reflow the centre and move the marked chrome rows the panel belongs to, so every hover would cost a grid transition plus an Electron app-region recollect.

**Rendering the preview into `shell.overlay`.** The overlay is a different slot owner; moving the subtree between render sites remounts it, and remounting the browsing region reloads nothing while discarding its local state.

**Exporting `usePointerGrace` from `ui-primitives`.** It is the internal close timer of `Menu` and `HoverCard`. The frame carries its own named dwell rather than widening a shared atom for one caller.

**Escape through `useModalLayer`.** The preview is not a modal, and registering it would claim top-layer Escape arbitration away from dialogs and menus that already own it.

**A keyboard-accessible trigger.** Keyboard users reach the column through the existing toggle, which is a durable expansion they can navigate; a hover surface that only a focus ring could summon would strand focus between two sites.

## Consequences

A session driven only by the keyboard needs one pointer press before hover-preview arms, because document modality follows the last input. The preview draws at `SIDEBAR_DEFAULT`, never at a forgotten drag width. The column's own toggle keeps the `toggle.open` name while previewing because pressing it commits rather than hides. On Windows the edge strip is the only trigger, since its reopen controls live in the caption row and the frame does not mount `shell.leading` there. A right panel presented fullscreen still covers the frame, preview strip included. Coverage lives in `packages/client/ui-layout/tests/layout-store.client.spec.ts`, `packages/client/ui-layout/tests/app-frame.client.spec.tsx`, and the `previewing a closed sidebar` block of `packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx`; the shipped sidebar snapshots render the same markup while not previewing.
