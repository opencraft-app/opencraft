# Mobile transient sidebar dismissal

## goal / requirement_refs
User reports intermittent failure when tapping the exposed conversation to close
the mobile conversation sidebar.

## non_goals
No Host, Thread, navigation, dock preference, or preview deployment change.

## interface_refs / history_context
`AppShell` owns `sidebarPeek` and floating presentation; `useSidebarDockIntent`
owns mouse hover acquisition; `resolveShellSpace` projects saved intent against
viewport budget. Existing window bubble-phase pointerdown outside listener can
miss descendant events. Preserve one Sidecar and stable portalled content.

## acceptance
First tap outside a floating sidebar closes it without activating covered
conversation controls. Internal menu/scroll remains usable; touch drag does not
acquire hover; wide dock intent survives mobile dismissal.

## context_receipt
Read root and OpenCraft AGENTS, OpenCraft maintenance SKILL and verification
reference in preceding turns. Read platform architecture, shell implementation,
responsive intent and adjacent sidebar tests this turn.

## affected_paths
AppShell, sidebar dock intent, Web styles, focused tests, platform/domain docs.

## validation / handoff
Focused sidebar/layout/pointer tests passed (26/26); Web typecheck,
`check:boundaries`, `build:web`, explicit docs-impact and `git diff --check`
passed. Existing preview service remains active with its previous bundle.
No phone or browser interaction run was available in this checkout, so the
first-tap behavior still needs live mobile verification after preview switch.
