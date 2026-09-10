# React runtime provenance

`useStableEvent` restores the public behavior of Codex Desktop's stable/latest
callback boundary from:

- `reference://codex/.runtime/source-tree-build-r1973-initializer-state-control-closure/shared/use-latest-callback.js:10-38`

The wrapper has one identity for a mounted component, while `useInsertionEffect`
publishes the implementation from the latest committed render. OpenCraft does not
read React private internals; render-phase invocation is prevented by ownership
and tests at the observer/layout call sites instead of Codex's private dispatcher
probe.
