# r3562 ResizeObserver ownership correction

2026-09-08. Follow-up to `codex-scroll-animation-parity.md`.

## Cause and reference

The viewport geometry observer also observed `.thread-scroll-surface`, an
ancestor of measured rows. A row observer synchronously commits list geometry;
that can resize the shallower surface after the browser has delivered the row
notification. The skipped ancestor notification produced the two warnings.

The extracted r3562 `oO` response wrapper instead initializes its update in a
layout effect, observes only the scrollport, and coalesces viewport/window
notifications with RAF. Its virtual list owns synchronous row measurement and
the independent latest-follow-content notification. There is no universal
"defer all measurement" rule.

The same ten-event sequence produced 0 warnings in the original functions and
2 in Vela. A test-only removal of the ancestor observation produced 0/0 without
changing settled geometry. That diagnostic transform has now been removed;
tests exercise the corrected production module directly.

## Changes

- `observeViewportGeometry`: scrollport only; immediate initialization and
  coalesced resize notifications, without a second content-height cache.
- Response wrapper installs this observer in a layout effect, as `oO` does.
- Row transactions and follow-content reporting retain their synchronous order.
- Vela's history-fill adapter receives a post-commit list-height notification.
  It retains its existing single-flight coordinator, and cannot take over row
  measurements, response follow, or scroll compensation. This is the integration
  of Vela pagination, not a claim that Codex has an identically named callback.
- Browser regressions now fail on ResizeObserver loop warnings instead of merely
  checking that they eventually stop.

## Verification

- 115 focused unit tests and Web typecheck pass.
- Ten-event original-function comparison: 0/0 warnings, settled geometry matches.
- Shared-clock long-answer fixture: 108 event boundaries, all frame geometry,
  rendered-row and follow-mode assertions pass; maximum geometry difference 0px.
- Production message renderer: 143 events, 2364 paired frames; maximum geometry
  difference 0px, row/follow assertions pass, zero resize warnings on both sides.
- Headless real scroll/continuous-submit/long-answer/restore smoke passes.
- Both natural and response-placement policies fill history after content shrinks,
  load once, and do not refetch on a plain rerender; zero resize warnings.

These compare extracted reference functions under a shared renderer and runtime,
not the entire installed Codex app. No production deployment is part of this change.
