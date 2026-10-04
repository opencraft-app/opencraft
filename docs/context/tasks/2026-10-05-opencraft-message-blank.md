## goal
Fix the recently introduced OpenCraft Web message blank after optimistic-to-authoritative Turn identity handoff, without requiring scrolling or switching conversations.

## non_goals
No commit, push, preview replacement, runtime restart, production change, task card, real account or inference. Preserve the existing dirty worktree and the history-hydration window fix.

## acceptance
- Same-count Turn ID replacement retains the stable client-message DOM and mounts later streaming content.
- History insertion retains the old last mounted row; reading positions are not taken over.
- Window/measurement/layout changes converge without a browser scroll notification in natural and response-placement modes.

## context_receipt
- Root and OpenCraft AGENTS, opencraft-maintenance skill and verification read; router query `opencraft message blank conversation rendering scroll virtualization` has no match, bounded source/test search used.
- Frontend-runtime adjacency and frontend/vitest.config.ts checked; no frontend synchronization change.
- Chat UI history/window contract, actual deployed JS, virtualizer source/test, real Conversation fixture and scroll smoke checked. Agent-runtime mapped formal domain updated with the repaired invariant.
- Prior evolution: 2026-09-30 stable clientId message presentation, 2026-10-04 stream-order surviving-window handoff; current source /data/mono2 dirty checkout matches the deployed faulty algorithm, not the isolated master delivery checkout.

## evidence
The prior investigation reproduced the defect with real Conversation in Chromium: after canonical ID replacement, latest DOM disappeared, spacer remained, later text stayed missing, one scroll restored it. Substituting only the pre-October-4 algorithm did not lose the latest DOM. Deployed JS includes the faulty survivor-only range. Safari has not been independently inspected.

## implementation
Preserve both the prior window slots anchored by a surviving row and all surviving mounted identities during handoff. Reconcile committed viewport on layout changes, not only entry count. Transfer measured height by stable client-message identity across canonical ID replacement: the supplementary reading test found a 26px fabricated correction when known height reverted to the 280px estimate; height transfer eliminates it. Keep viewport ownership and response policy separate; do not force bottom scroll or remount the conversation.

## validation
- Red: canonical edge handoff test returned endIndex 3 rather than 4; supplementary real reading test showed a 26px correction from losing known height.
- Green: all 60 virtualizer tests; full chat/Composer test entry equivalent passed with dot reporter; virtualizer/Web typechecks and platform/typography boundary checks passed.
- Final complete real Conversation scroll smoke passed: existing streaming, submit/restore/wheel/spacer geometry; canonical ID handoff across three consecutive sends in both natural and response-placement modes retains identical row/bubble DOM, subsequent streaming appears without scroll, and history-reading anchor remains fixed. Zero ResizeObserver loop warnings.
- Desktop and touch-sized real history-order smoke passed eight interleavings each, retaining live DOM and completion content.
- Final Web release build succeeds at /tmp/opencraft-message-window-final-6JlLp8/web, buildId 20261005-message-window-fix. Existing URL/dynamic-import/chunk warnings remain; not a headless runtime package and never deployed.
- Documentation validator, explicit-path/staged mapped impact guard and scoped whitespace checks passed. No staging, commit, push, preview replacement or runtime restart.
- Safari real-device and actual user fault DOM are not independently verified; Chromium real-component replay is not Safari acceptance.
