# Browser contracts and tool semantics

This package owns platform browser semantics. It must not import a harness,
generated AppServer types, Electron, Node, React, or PreviewBridge.

- `src/automation/`: physical automation port, results, errors and shared policy.
- `src/tools/`: harness-neutral tool catalog, trusted invocation context and dispatch.
- `src/metadata-merge.cjs`: platform-neutral three-way record merge used by the
  gateway and browser projection. Unchanged rows preserve remote changes;
  concurrent edits to the same row fail explicitly. Keep its browser CJS entry
  in Workbench's explicit Vite prebundle list.
  Authoritative retirement facts filter only their resource identities out of
  stale/pending edits; they must not discard unrelated drafts or bindings.
- `src/automation.ts`: compatibility export; keep existing consumers working.

Tools receive their owner/execution context from trusted composition, never model
arguments. Images and text remain distinct result kinds until an adapter formats
them. A transport exception is not proof that a mutating operation did not execute.

Migration TODO and runtime inventory live in
[the automation migration plan](../../docs/architecture/browser/automation-migration.md).

- [ ] Add document/frame identities to the automation port without changing
  PreviewBridge's existing revision semantics implicitly.
- [ ] Carry cancellation and operation receipts through the platform capability
  gateway; do not implement replay in harness adapters.
