# ResizeObserver ownership correction

2026-09-08.

## Cause

The viewport geometry observer also observed `.thread-scroll-surface`, an
ancestor of measured rows. A row observer synchronously commits list geometry;
that can resize the shallower surface after the browser has delivered the row
notification. The skipped ancestor notification produced the two warnings.

## Changes

- `observeViewportGeometry`: scrollport only; immediate initialization and
  coalesced resize notifications, without a second content-height cache.
- Response wrapper installs this observer in a layout effect.
- Row transactions and follow-content reporting retain their synchronous order.
- the downstream product's history-fill adapter receives a post-commit list-height notification.
  It retains its existing single-flight coordinator, and cannot take over row
  measurements, response follow, or scroll compensation. This is the integration
  of the downstream product pagination.
- Browser regressions now fail on ResizeObserver loop warnings instead of merely
  checking that they eventually stop.

## Verification

- 115 focused unit tests and Web typecheck pass.
- Headless real scroll/continuous-submit/long-answer/restore smoke passes.
- Both natural and response-placement policies fill history after content shrinks,
  load once, and do not refetch on a plain rerender; zero resize warnings.

The recorded checks do not constitute a new production deployment.
