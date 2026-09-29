# OpenCraft floating sidebar outside-tap flash

## goal / requirement_refs
Restore the mobile behavior where tapping to the right of the open floating
sidebar dismisses it without a full-screen flash.

## non_goals
No Host, session, menu-action or persistent deployment changes.

## interface_refs / history_context
`AppShell` now renders a viewport-sized transparent button as the outside hit
surface. The former implementation used a window `pointerdown` listener. The
new surface is needed to consume the tap instead of also activating covered
conversation content, but iOS can paint the button's default tap highlight over
its full viewport bounds. `useSidebarDockIntent` remains the dismissal owner.

## acceptance
Outside tap dismisses one floating sidebar; it does not tap-through or paint a
viewport highlight. Desktop hover and edge reveal remain unchanged.

## context_receipt
Read root and OpenCraft `AGENTS.md`, OpenCraft maintenance skill and verification
reference, `docs/platform-architecture.md` floating-sidebar contract and the
current AppShell/CSS/test implementation. Context router returned no pack; used
bounded exact search. Adjacency catalog has no OpenCraft card.

## affected_paths
Workbench Web sidebar surface CSS, focused sidebar-dock test, platform design.

## validation / handoff
Focused sidebar-dock tests passed (22), Workbench Web typecheck and headless
release build passed. Temporary preview now serves build
`20260928224943-501f18f36496`; health, version, CSS and entry JS responded,
and the existing server PID stayed unchanged. Mobile Safari visual verification
remains outstanding; source/build checks cannot prove the actual tap appearance.
