# Long-answer scrolling: headless investigation, 2026-09-08

The new optional fixture streams six 500-character Chinese text bodies, 3,078
characters with headings, through a single latest assistant item. Text uses browser
line wrapping (650px wide, 16px font, 26px line height), not synthetic fixed heights.
Viewport is 700px tall, with an 80px footer. Historic turns remain virtualized.
The injected state probes only read follow state.

Each text update advances 12 animation frames (192ms). Normal action/phase
boundaries advance 48 frames (768ms). An additional fast-boundary variant uses
12 frames throughout. Samples include scroll distance, scroll height, spacer,
visible row coordinates, text end, phase and follow mode.

## Normal-boundary results

106 event boundaries were exercised in the recorded investigation.
This is finite fixture coverage, not validation of a live provider stream.

| Sequence | Response-placement behavior |
| --- | --- |
| At bottom before send, direct final answer grows to six essays | `static`; stays at answer beginning |
| At 600 characters, invoke bottom action; continue to 1,800 | `user_follow`; distance remains 0px |
| Real Chromium mouse wheel upward 400px, then continue to 3,078 | `static`; distance grows from 400px to 1,414px without moving the reading anchor |
| Prework content overflows, then switches to six-essay final answer | `prework_follow` → `user_follow`; distance remains 0px through completion |

In the direct-final case the final streaming distance was 2,497px in this fixture.
An idle bottom position therefore does not itself grant the next answer persistent
follow ownership. Already-acquired follow survives continued growth of the same
answer; an explicit user scroll upward relinquishes it.

No production scrolling policy was modified for this investigation. In particular,
the test does not justify adding a rule that all long final answers force-follow.

## Follow-up: production renderer and real button (2026-09-08)

The user reports that explicit bottom-follow is still absent in the real page.
The preceding fixture/API test does not disprove that report.

The production-renderer fixture uses the actual registered
`TextTimelineRenderer` / `WebChatDocument` Markdown path. At 1,200 characters the
candidate's visible `Scroll to bottom` button receives trusted Chromium mouse
input at its bounding rectangle, instead of directly calling the scroll API.
The source continues to grow in the SAME assistant item through all six essays
and completion. A separate Turn tests wheel detachment, so that detachment no
longer truncates the explicit-follow-to-completion test.

The real-clock fixture uses no Playwright clock installation or pause;
sampling uses actual browser animation frames. This variant passed 141 event
boundaries within 1px. Candidate state after clicking was `user_follow`, and its
distance remained 0px through the 3,078-character message and completion. Normal
mouse-wheel detachment still changed it to `static`.


Remaining untested boundary: real host protocol events → timeline projection →
application route/component lifetime. Fixture blocks deliberately keep a stable
Turn/item identity and active status; they cannot establish that the real host
does so. Production was read-only inspected and still identifies build
`20260908014409-3e0c9d4ba12f`. No active live stream was captured from the historical
conversation URL inspected. No production policy fix or deployment was made;
the reported live failure remains unconfirmed, not resolved.
