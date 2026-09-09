# Six-essay scrolling: headless comparison, 2026-09-08

> Scope correction: the original response policy below is gated, not the only
> Codex scrolling path. The subsequent [policy audit](codex-natural-chat-scroll-policy-audit.md)
> demonstrates natural no-click following through the original gate-false path.
> This report's earlier parity results must not be generalized across policies.

## Scope and method

Compared the workspace Web `Conversation` against extracted r3562 scroll-layout,
response-policy and virtualizer function bodies in headless Chromium. The reference
root is `/data/mia/.runtime/lifecycle-authority-dead-contract-r3562`.
The harness logs SHA-256 fingerprints of the extracted functions.

Both endpoints use Vela's row presentation. This is **not** a running full Codex
application or a production Hermes/AppServer replay. No messages were sent to a
real conversation. The test does not cover protocol timing/classification upstream
of the provided timeline blocks.

The new optional fixture streams six 500-character Chinese text bodies, 3,078
characters with headings, through a single latest assistant item. Text uses browser
line wrapping (650px wide, 16px font, 26px line height), not synthetic fixed heights.
Viewport is 700px tall, with an 80px footer. Historic turns remain virtualized.
The injected state probes only read the original/candidate follow refs.

Each text update advances 12 animation frames (192ms). Normal action/phase
boundaries advance 48 frames (768ms). An additional fast-boundary variant uses
12 frames throughout. Samples include scroll distance, scroll height, spacer,
visible row coordinates, text end, phase and follow mode.

## Normal-boundary results

106 event boundaries passed the geometry comparison; this run recorded 0px maximum
sampled scalar/anchor difference. This is finite test coverage, not global parity.
The original 18-event synthetic regression also passed after extending the fixture.

| Sequence | r3562 functions | Vela |
| --- | --- | --- |
| At bottom before send, direct final answer grows to six essays | `static`; stays at answer beginning | Same |
| At 600 characters, invoke bottom action; continue to 1,800 | `user_follow`; distance remains 0px | Same |
| Real Chromium mouse wheel upward 400px, then continue to 3,078 | `static`; distance grows from 400px to 1,414px without moving the reading anchor | Same |
| Prework content overflows, then switches to six-essay final answer | `prework_follow` → `user_follow`; distance remains 0px through completion | Same |

In the direct-final case the final streaming distance was 2,497px on both endpoints.
An idle bottom position therefore does not itself grant the next answer persistent
follow ownership. Already-acquired follow survives continued growth of the same
answer; an explicit user scroll upward relinquishes it.

## Confirmed differences / unresolved scope

1. **Empty final-answer item is misclassified by Vela.** r3562 `AD` treats an
   `agentMessage` with phase other than commentary as final, even without text.
   `deriveTimelineLatestTurnPhase` additionally requires `text.trim().length > 0`.
   At empty submission the probes read original `static/final_answer` versus Vela
   `prework_watch/prework`. Both converge to `static/final_answer` at the first
   nonempty chunk in this test. This is a real semantic difference, but this test
   does not establish it as the cause of the reported lost follow.

2. **Fast animation-boundary behavior is not equivalent.** With 192ms boundaries,
   the large prework update arrives before placement animation settles. The
   reference endpoint retains a 302.359375px response spacer; Vela clears it to 0px.
   Both still enter `prework_follow`, then `user_follow`, and keep scroll distance
   at 0px. The fast variant deliberately fails the geometry assertion; it is not
   hidden by the normal-boundary pass. An original/original control passed with
   the same retained spacer on both endpoints. This narrows the difference to
   animation/measurement execution in this harness, not a demonstrated loss of
   follow and not yet proof of full Codex application's visible behavior.

No production scrolling policy was modified for this investigation. In particular,
the test does not justify adding a rule that all long final answers force-follow.

## Reproduction

From `/vela`, with the local Playwright module and Chromium executable configured:

```sh
CODEX_SCROLL_ESSAYS=1 npx tsx scripts/compare-codex-scroll.ts
CODEX_SCROLL_ESSAYS=1 CODEX_SCROLL_BOUNDARY_FRAMES=12 npx tsx scripts/compare-codex-scroll.ts
CODEX_SCROLL_ESSAYS=1 CODEX_SCROLL_BOUNDARY_FRAMES=12 CODEX_SCROLL_CONTROL=1 npx tsx scripts/compare-codex-scroll.ts
```

Executable overrides: `OPENCRAFT_PLAYWRIGHT_MODULE` and
`OPENCRAFT_CHROMIUM_EXECUTABLE`. Completed/detached screenshots are written under
`/tmp/scroll-essays-*.png`; detailed sample records are emitted as JSON lines.

Relevant implementations: `packages/chat-core/src/timeline-turns.ts`,
`packages/timeline-virtualizer/src/follow.ts`,
`apps/workbench-web/src/components/conversation.tsx`. Reference classifier/reducer
are `AD` / `OD` in `lazy/app-initial/local-conversation-thread-CShhuS2f.js`.

## Follow-up: production renderer and real button (2026-09-08)

The user reports that explicit bottom-follow is still absent in the real page.
The preceding fixture/API test does not disprove that report.

Added `CODEX_SCROLL_RENDERER=production`: streamed bodies use the actual registered
`TextTimelineRenderer` / `WebChatDocument` Markdown path. At 1,200 characters the
candidate's visible `Scroll to bottom` button receives trusted Chromium mouse
input at its bounding rectangle, instead of directly calling the scroll API.
The source continues to grow in the SAME assistant item through all six essays
and completion. A separate Turn tests wheel detachment, so that detachment no
longer truncates the explicit-follow-to-completion test.

Added `CODEX_SCROLL_REAL_CLOCK=1`: no Playwright clock installation or pause;
sampling uses actual browser animation frames. This variant passed 141 event
boundaries within 1px. Candidate state after clicking was `user_follow`, and its
distance remained 0px through the 3,078-character message and completion. Normal
mouse-wheel detachment still changed it to `static`.

```sh
CODEX_SCROLL_ESSAYS=1 CODEX_SCROLL_RENDERER=production CODEX_SCROLL_REAL_CLOCK=1 npx tsx scripts/compare-codex-scroll.ts
```

Remaining untested boundary: real host protocol events → timeline projection →
application route/component lifetime. Fixture blocks deliberately keep a stable
Turn/item identity and active status; they cannot establish that the real host
does so. Production was read-only inspected and still identifies build
`20260908014409-3e0c9d4ba12f`. No active live stream was captured from the historical
conversation URL inspected. No production policy fix or deployment was made;
the reported live failure remains unconfirmed, not resolved.
