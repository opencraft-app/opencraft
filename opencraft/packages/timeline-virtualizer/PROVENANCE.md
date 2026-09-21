# Timeline virtualizer provenance

This package is a typed, renderer-neutral restoration of the Codex Desktop
`VirtualizedTurnList` model. The behavior baseline is:

- `reference://codex/.runtime/source-tree-build-r1316-owner-adoption-abi/lazy/app-initial/thread-virtualizer-D5BSbZuA.js`
- `reference://codex/.runtime/source-tree-build-r1316-owner-adoption-abi/lazy/app-initial/open-sources-side-panel-tab-CfgjOF5O.js:139-820`
- `reference://codex/.runtime/source-tree-build-r1316-owner-adoption-abi/lazy/app-initial/thread-scroll-layout-xQ2_L08y.js`
- `reference://codex/.runtime/source-tree-build-r1316-owner-adoption-abi/lazy/app-initial/local-conversation-thread-CShhuS2f.js:9159-9795`

The shared package intentionally contains no React, DOM, Expo, or React Native
imports. Web and Native adapters must supply measurement, scrolling, and layout
scheduling through the ports in `src/ports.ts`.

`src/history-backfill.ts` restores the history-loading control mechanism from
the latest recovered source:

- `reference://codex/.runtime/source-tree-build-r1973-initializer-state-control-closure/lazy/app-initial/thread-scroll-layout-xQ2_L08y.js:145-182`
- `reference://codex/.runtime/source-tree-build-r1973-initializer-state-control-closure/lazy/app-initial/local-conversation-thread-CShhuS2f.js:10799-10820`

It retains the original single-flight rule, layout-owner generation, post-page
layout barrier, viewport-fill loop, and unchanged-height stop condition. The
React callback-identity boundary lives in `@opencraft/timeline-react`; DOM and Native
hosts continue to provide their own metrics and frame scheduler.

`src/follow.ts` restores the parent `LocalConversationThread` policy that sits
above the list itself. Its `static`, `prework_watch`, `prework_follow`, and
`user_follow` reducer is the typed form of the recovered `OD` state machine at
`local-conversation-thread-CShhuS2f.js:8896-8933`. Latest-Turn placement,
response-spacer geometry, and restore normalization retain the recovered
24/300/2⁄3/240 constants. They stay renderer-neutral; Web and RN adapters own
only their scroll calls, measurement events, and animation primitives.

## Platform rule

`VirtualizedTurnViewportState.renderedRange` is the only window authority on
every platform.

- Web renders the slice inside a full-height spacer, observes Turn elements with
  `ResizeObserver`, and normalizes the inverted scroll container to
  `distanceFromBottomPx`.
- Expo/RN renders the same slice inside a full-content-height Native container,
  reports row heights through `onLayout`, and normalizes `contentOffset`,
  `contentSize`, and viewport size to `distanceFromBottomPx`.
- `FlatList`/`VirtualizedList` may be used as a mechanical host only when its
  internal window does not become a second source of truth. Passing the complete
  Timeline to an independently configured Native virtualizer is not compatible
  with this package's cross-platform contract.
- Both platform adapters consume the same Turn follow reducer. A local
  `isAtBottom`/`followOutput` boolean is a second policy and is not allowed.
