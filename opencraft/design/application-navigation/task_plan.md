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
