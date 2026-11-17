# Application navigation refactor

## Goal / non-goals
One Router authority for desktop/Web and connected/hostless application routes. Preserve Host, Thread, Draft and View ownership. No deployment, user-data migration, backend changes or unrelated UI redesign.

## Phases
- [x] Red: route publication, late navigation, true POP/forward, Chat return and hostless tests.
- [x] Replace handwritten History mutations with React Router memory/browser adapters.
- [x] Migrate transactions and both Shells; retain resource lifecycle.
- [x] Type/tests/build, Electron navigation sequences, AGENTS and formal contract.

## Contract
- Desktop uses memory routing; Web uses browser routing. Navigation survives Settings transitions, not a promise of cross-process desktop history persistence.
- openChat is explicit return to the remembered conversation (or Home), never a disguised history.back. Home creates/presents a draft separately.
- Router owns path/key/state/action. View identity is distinct from conversation identity. History controls consume a projection of Router entries, not a competing path writer.
- Navigation intent invalidates older async work; failed or late preparation does not alter the destination/history. POP targets restore their own View; failure has explicit rollback.
- No Host is a supported state of the same application router, not a second history implementation.
- Sidebar A→B→A selects the last successfully presented, still-owned input slot. A bounded canonical-conversation map remembers it; failed/late navigation never does. Explicit navigate creates an independent View; POP keeps its entry.
- Presentation and input budgets are independent: 20 inactive Views versus 50 nonempty draft owners. Evicting a View preserves its input; input eviction revokes the preferred slot. Promotion updates retained input even if the old presentation was evicted. Account changes clear preferred memory and fence unaccepted navigation.

## Errors
The old history spy tests failed after migration because they asserted direct window.history calls; replaced them with actual Memory Router POP/destination assertions. Red tests proved same-location publication and stale preparation faults before implementation. Remaining validation in progress.

## Handoff
Refactor and focused acceptance complete. 50 navigation/activation/chrome/legacy-route tests pass; Web/runtime typechecks, boundaries and Electron build pass. Full Workbench suite retains its pre-existing typography assertion failure; not an all-green gate claim. Real browser owner reset + reload/forward and real Electron Settings/Back/Forward/Chat with preserved draft passed. Installation/release not performed.

## Settings entrance opens a default destination

The Shell gear previously changed only a sidebar destination, leaving Chat in the
main surface until a category was selected. Active and hostless Workbenches now
send that entrance through the existing openSettings intent, whose default is
Appearance. Removed the unreachable sidebar-only settings destination; the
Router remains the sole route writer. Settings is route-owned for the transient
Shell, so a narrow touch drawer dismisses and reveals the selected settings page.
Applications retain their separate sidebar behavior.

Validation: 28 existing Router/navigation regressions pass, including memory and
hostless navigation; Web TypeScript and platform/control boundaries pass. Viewed
the actual running Web entry using desktop keyboard, desktop touch and a narrow
phone touch context. Each gear activation reached /settings/appearance, selected
Appearance in navigation and showed its real settings content. Back restored the
same unsent composer text; Forward returned to Appearance. Initial review caught
the transient drawer still covering mobile Settings, which was corrected by the
route-owned Shell flag before acceptance. Artifacts viewed:
/tmp/opencraft-default-settings-{keyboard,touch,phone}.png. The running local Web
serves the change; an installed Electron binary was not rebuilt or inspected.

## Reopened Agent setup follows the current destination

Non-gate Agent setup stays inside the route stage, leaving the real Settings
navigation reachable. A Router revision dismisses this transient presentation;
the overlay does not write history. Completing setup with a retained draft uses
the existing Chat-return intent after applying the model selection, preserving
that draft. The covered route is inert while setup is open. Live Web acceptance
covered Settings -> setup -> Appearance, explicit return to model settings, and
setup -> Start -> Chat with the original unsent draft and a successful native
Cursor response. Existing 67 Router/restore tests pass. Full evidence and the
unrelated mobile gate failure are recorded in the Agent history task plan.

## Sidebar conversations with previously saved input

The two reported remote conversations matched client errors at 16:24:22–23:
"Initial Workbench View has already been presented". Fresh browser contexts
opened them successfully, while durable draft storage returned a saved View ID
in the user's existing context. That selection branch incorrectly called the
bootstrap-only mountInitial entry. Its previous timing smoke used an unrestricted
mock and therefore missed the actual coordinator's one-time initialization guard.

The shared activation/coordinator owners now have a dedicated retained-View
presentation path. It reconstructs the input owner when only the persisted ID
exists, rejects an existing slot bound to a different conversation, keeps the
same Composer/View identity, and starts readiness independently of cached paint.
New-chat local presentation shares the same resource replacement primitive.
Initial mounting keeps its one-time guard. Router remains the sole history owner.

A regression using the actual coordinator reproduced the reported error before
the fix, then passed. Tests also cover an absent input owner after restart,
waiting Host readiness, invalid restored targets, preserved input, POP/forward
and newer Settings intentions. The timing smoke now refuses bootstrap reuse.
70 application restoration/navigation tests and the relevant Host/draft tests
pass; Web/runtime TypeScript and platform boundaries pass.

Live Web acceptance opened "新增镜像制作流程" and "新增文档更新分类筛选项"
on the existing enrolled machine, stored independent synthetic unsent drafts in
an isolated browser context, reloaded the application at Home, and opened each
again. Both real histories rendered and both drafts were restored; no activation
error was logged. Nothing was sent to either Agent. Evidence:
/tmp/opencraft-restored-sidebar-desktop-0.png and
/tmp/opencraft-restored-sidebar-desktop-1.png.
Repeated the same persisted-draft sequence with genuine touch input at 390x844;
waited for the machine's current directory to enable its rows before tapping.
Both destinations and drafts restored without activation errors. Viewed
/tmp/opencraft-restored-sidebar-touch-1.png alongside the desktop evidence.
The live runtime-error endpoint was empty after acceptance. Tests never sent a
message to either existing conversation.
The source preview consumes this client change; no Host/remote process restart,
installed Electron build or release is part of this correction.
