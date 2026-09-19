# Reference findings

- DSH pinned 0.1.1-rc.2: dsh-client-ui-model-selection ModelDirectory separates current/routable/groups, fences late results. ApiProxy selectionFor uses process pick, logged request, default; process-only picks are not promised durable.
- ref/codex is mia-recovered-renderer. fork-conversation-04177 sends thread/fork without replaying normalized tools; promotes capability status separately. update-thread-settings-and-sync-model-03795 initializes model from fork response and separates latest settings from previous-turn model.
- Local fork passes normalized DshHostCapability[] back into DynamicToolSpec validation after creating child. A minimal broker call reproduces the exact error.
- Local fork selects child model then internally resumes without passing it. Read-only describe sees only request/header; empty seed returns undefined and adapter emits dsh. Catalog then persists that invalid identity. Ordinary start already saves valid configuration; avoid overstating the fault.
- Real cold client hydration re-registers tools even before native activation. Registration now validates schema without Agent, accepts declaration at Host, defers engine mount if absent, and activation mounts idempotently. Native release removes mounted scope. The Host restart loop no longer calls session.models for every idle capability owner.
- No full Codex Rust server source was found in the requested ref; the migrated reference concerns recovered client state/contracts, not an assertion about server transaction internals.
