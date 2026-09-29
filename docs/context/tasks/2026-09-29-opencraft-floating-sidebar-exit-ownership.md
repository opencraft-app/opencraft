# OpenCraft floating sidebar exit ownership

## goal / requirement_refs
Fix the mobile outside-tap flash by keeping one owner for the sidebar content
and outside hit surface throughout the floating exit animation.

## non_goals
No Host/session changes, desktop dock redesign, reference-code copy, or
persistent deployment.

## interface_refs / history_context
`AppShell` previously switched all `SharedSidebarContent` portal targets as soon
as `showFloatingSidebar` became false. `FloatingLeftPanel` uses `AnimatePresence`
and remains visible until its exit animation completes. Thus the outgoing
surface could be empty while its content had already moved to a hidden dock.
Paseo snapshot `3cc4ae2` separates mobile panel target, motion target and
settled target, and retains panel activity until motion settles. OpenCraft
borrows that ownership invariant, not its React Native component structure.

## acceptance
Outside tap is consumed once. While the floating panel is exiting, its content
and outside hit surface remain mounted; after exit they release together.
Quick reopen cancels stale release. Docking still transfers immediately.
Sidebar state/scroll/focus and reduced-motion behavior remain intact.

## context_receipt
Read root/OpenCraft AGENTS, the OpenCraft maintenance skill and verification
reference, current platform sidebar contract, AppShell/FloatingLeftPanel/
SharedSidebarContent and Paseo mobile-panel model/presentation/tests. Root
context router returned no pack; used bounded exact source search. Adjacency
catalog has no OpenCraft card.

## affected_paths
Workbench Web AppShell/FloatingLeftPanel, sidebar smoke and focused test,
platform architecture and workspace invariant.

## validation / handoff
Focused sidebar/geometry tests passed (39), Workbench Web typecheck,
platform-boundary check, headless release build and diff whitespace check
passed. The smoke script now samples the first exit frame, interrupted reopen,
reduced-motion close and outside-tap non-penetration, but could not execute on
this machine because Playwright/Chromium are unavailable. Temporary preview
serves `20260928233639-ac0547c1515d`; health/version/entry assets match and
the server PID stayed `3447147`. The previous entry is backed up at
`/data/opencraft-sidebar-exit-final-backup-JEiGmO` for rollback. Actual iOS
touch appearance still requires device verification.
