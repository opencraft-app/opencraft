# Timeline React provenance

`useTurnHistoryBackfill` is the React ownership adapter for the renderer-neutral
history coordinator. Its behavior follows Codex Desktop's combination of:

- stable/latest callback dispatch in `shared/use-latest-callback.js:10-38`;
- the generation and single-flight pagination loop in
  `lazy/app-initial/thread-scroll-layout-xQ2_L08y.js:145-160`;
- the ResizeObserver geometry de-duplication owner in the same file at
  `thread-scroll-layout-xQ2_L08y.js:163-182`.

The package intentionally does not own DOM or React Native APIs. Web supplies
`scrollHeight/clientHeight`; Expo supplies `contentSize/layoutMeasurement`; both
use the same semantic generation and loading transaction.
