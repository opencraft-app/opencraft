# Conversation viewport ownership

This change concerns measurement, compensation and follow-content ownership; it
does not change AppServer semantics, Composer layout or input-direction attribution.

## Ownership

| Fact / decision | Owner |
| --- | --- |
| DOM registrations, ResizeObserver samples, footer geometry | `WebConversationViewportOwner` |
| Measured row heights, virtual layout, render window, historical-row compensation, target positioning | `VirtualizedConversationTurns` child; `createTurnMeasurementTransaction` is its pure calculation |
| Latest response placement, restored response state, follow mode | `Conversation` latest-turn policy |
| Durable scroll distance and platform scroll writes | Scroll controller |
| Which inner content participates in following | Latest-turn render slots |

A row-height event and a follow-content event are different facts. The latter
can occur without the former. Final-answer slots participate; a user's message
and the activity disclosure header do not. The last non-user activity unit is
registered independently of its outer activity block. Registrations belong to
their exact DOM lifetime and are cleaned up when the slot exits.

## Invariants preserved by this change

1. First measurement is a baseline, not growth:
   `contentDelta = previousMeasuredHeight == null ? 0 : measuredHeight - previousMeasuredHeight`.
   Virtual-layout correction is separately `measuredHeight - previousLayoutHeight`.
2. Presence of a restore delegate is independent of its current result.
   A delegate returning `null` still establishes latest-turn ownership: the
   virtualizer compensates changed historical rows below the reading anchor,
   while the latest-turn policy handles latest-row growth. No numeric-only
   legacy option remains.
3. A measurement transaction commits a coherent height table, layout and render
   window before notifying the latest-turn policy or writing its scroll correction.
   Pending transactions fence ordinary scroll-window updates and accumulate deltas.
4. A shared ResizeObserver batch commits rows first, then publishes follow-content
   geometry from registrations that survived that commit. Removed targets cannot
   publish stale follow geometry.
5. Newly mounted rows are measured before paint; latest-turn updates have a
   synchronous measurement path. Async ResizeObserver remains responsible for
   subsequent intrinsic geometry changes. Stable row refs prevent false remounts.
6. Follow-content height is never initialized from whole-row height. Restored
   row-height baselines can only be consumed by row-height events.
7. Initial live mount and subsequent sends share one Activity transition. The
   initial allowance and page-owned submit snapshot are each consumed once;
   an ordinary rerender cannot replay placement. Replica-only identity changes
   do not acquire local-submit placement authority.
8. Every row retains the same animation wrapper when it becomes historical.
   Only its `y` changes to zero; its children, local state and DOM survive.
9. Stopping response animation is distinct from clearing response space.
   Completion stops motion, while explicit clearing resets spacer/intersection
   evidence. Consecutive sends animate from the existing spacer, not from zero.
10. A no-placement submission returns from Activity policy immediately after
    preserving reading position. Its `scrollHeight` delta is signed, including
    shrinking content. Spacer shrink samples distance before mutating geometry.
11. Measurement effects precede Activity placement through the actual React
    parent/child relationship: `Conversation` → `VirtualizedConversationTurns`.
    The parent cannot inspect the child's pending measurement transaction,
    measured-height table or render window. The old parent-side measurement
    fence is removed. Pending transactions are local virtualizer concerns.
12. The controller publishes `isScrolledFromBottom` (>24px) independently of
    bottom-button visibility. The Web response consumer subscribes
    to that bit and renews its spacer observer on the same boundary. Completion
    itself does not acquire permission to clear response space.

The child publishes measurement facts and an imperative targeting / restore API.
The parent supplies its restore delegate and spacer getter, not mutable policy
refs. The DOM owner and controller remain the only platform resource / scroll
write owners. This separation improves portability without adding a new generic
policy. Expo still has a combined native host: shared pure rules are reusable,
but this Web split is **not** an implemented Expo lifecycle port.

## Long Turns are not a separate follow policy

Follow decisions distinguish intent from
length. A newly placed response starts in `static`. Work enters `prework_watch`;
overflowing registered work content with response space enters `prework_follow`.
That follow mode transfers to `user_follow` when the final answer starts.
Wheel input away from the bottom leaves follow; explicit bottom intent reacquires
it. Direct final-answer streaming from `static` retains the response's beginning
even if the answer grows beyond one viewport. Length alone cannot acquire follow.

The tests exercise 1,800–7,600px rows, a real Chromium wheel event, continued
growth while reading, bottom-button reacquisition, direct-answer static mode,
and restoration of an active Turn without replaying initial placement.

## Verification

`npm run test:chat` covers the measurement transaction and owner lifetime tests.
`npx tsx --test tests/shell/workbench-timeline-host.test.ts` checks host integration.

`npx tsx scripts/smoke/conversation/smoke-conversation-scroll.ts` runs the real Conversation and
viewport owner in headless Chromium against deterministic local content. It checks
first measurement, streaming bottom-follow, historical/latest growth while reading,
completion, return to bottom, content-only resize, and prework-to-final transfer.
It does not connect to a provider or send production messages.

The `?submissions` fixture additionally uses user + assistant rows and checks
three consecutive sends, exact DOM identity across historical demotion, one
snapshot consumption per Activity, monotonic frame-by-frame placement, spacer
reuse, completion stability, preservation during signed height shrink, and
replica-only updates. Expected history movement accounts separately for new
row height, the 12px row gap, existing scroll distance, and spacer delta.
The first-live-mount check uses the same consumer as later submissions.

### Known boundary — offscreen latest-row estimate

The signed-shrink test deliberately gives the new row the 280px estimate's
actual height to isolate signed snapshot compensation. It does **not** prove
anchor preservation when an initially unmounted latest row subsequently gets
its first, different measurement. A diagnostic with distance 1,000px, old row
content shrinking 900→20px, and a new 60px content row reproduced a 164px anchor
shift (280px estimate minus 116px measured row). The new row was absent at
snapshot consumption. Merely reordering layout effects cannot fix that case.

The measurement transaction excludes the latest row from historical estimate
compensation when a delegate exists, and reports zero content growth for its
first measurement. Those rules remain unchanged here; claiming a blanket
no-jump guarantee would be incorrect. This edge needs a separate ownership
decision and runtime verification, not a text-height-specific correction.

For an externally installed browser, set `OPENCRAFT_PLAYWRIGHT_MODULE` to its
Playwright module and `OPENCRAFT_CHROMIUM_EXECUTABLE` to Chromium's executable.

The local browser run observed two transient `ResizeObserver loop completed with
undelivered notifications` warnings during geometry changes. Position assertions
passed and idle sampling confirmed convergence; this is not a claim of zero
browser warnings or production reproduction of every historical report.
