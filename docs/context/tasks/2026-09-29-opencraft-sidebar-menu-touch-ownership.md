# OpenCraft sidebar menu touch ownership

## goal / requirement_refs
Fix the mobile sidebar task menu: selecting Rename, Fork, Archive or another
item must execute that item, not reopen a menu. Model ownership before changing
the running preview.

Follow-up: repeated taps on different task menus must never leave multiple
menus visible. The Sidebar owns one open Host/Thread/entry identity; row menu
roots project it instead of owning independent open state.

## non_goals
No Host command/protocol changes, no preview replacement, commit, deployment,
or production operation. The recovered Codex snapshot is a read-only design
reference, not a runtime authority.

## interface_refs / history_context
`ThreadRowMenu` nested `DropdownMenu.Root` inside `ContextMenu.Trigger`. React
Portal events can still bubble through that trigger; Radix starts touch
long-press handling there. The menu items already share one action model.
Codex's recovered sidebar uses one context menu for the row and a separately
owned overflow menu elsewhere; it also cancels pending pointer interaction
before opening its rename dialog. OpenCraft keeps its existing menu vocabulary.

## acceptance
The task row alone is the context-menu hit region; the sibling ellipsis button
alone triggers the dropdown. Both render the same actions. Touching a dropdown
item cannot reach the context trigger. Desktop context menu, row navigation,
touch hit area, keyboard focus and modal handoff remain usable.
Opening a second row or switching from dropdown to context menu closes the
previous menu; a late close callback from the old row cannot dismiss the new
one. No preview replacement is part of this follow-up.

## context_receipt
Read root and OpenCraft AGENTS, `docs/context/project/services/opencraft.md`,
`opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and its verification
reference. Context route matched `service-opencraft`. The adjacency catalog has
no OpenCraft-specific card, so bounded source and focused tests were used.

## affected_paths
Workbench Web thread menu and sidebar CSS; sidebar activity regression test;
OpenCraft chat architecture and design invariants.

## validation / handoff
Focused sidebar-activity tests (5), Workbench Web typecheck, production Web
build, platform boundaries, docs-impact and diff whitespace checks passed. The source and build
changed, but the running preview was not replaced. No attached mobile browser
or Playwright/Chromium runtime was available for actual tap/focus verification;
that remains the next acceptance check.

For the follow-up single-open fix, the focused sidebar-activity tests (6),
Workbench Web typecheck, isolated production Web build, platform boundary
check, documentation validation and diff whitespace check passed. On user
request, the headless Web build `20260929023352-7c5388ad9f9f` replaced only
the running preview's static Web directory; old hashed assets and the previous
Web directory remain available for rollback. `/version.json`, health and both
new/old entry scripts returned successfully, while the Host PID stayed
unchanged. Real mobile repeated-tap verification is still pending.
