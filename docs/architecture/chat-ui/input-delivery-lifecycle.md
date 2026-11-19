# Durable follow-up delivery and stopped executions

A received message must remain visible and recoverable when its execution stops.
The Host owns accepted message bytes and identity. Native history is evidence of
context adoption, not the only receipt for sending a message.

The receipt has four independent facts:

| Fact | Authority | Meaning |
| --- | --- | --- |
| Custody | Host queue commit | The Host durably received this exact message and author |
| Native admission | Native RPC receipt | The engine accepted this delivery attempt; a timeout remains unknown |
| Context | Exact client-message identity in native history | A corresponding context item was recorded; no claim that the model understood or acted on it |
| Execution | Exact native Turn terminal event or paged Turn history | That bound execution completed, failed or was interrupted |

Terminal execution never manufactures positive or negative context evidence.
“Received; turn stopped” acknowledges custody and execution termination while
retaining unobserved adoption in the receipt. It does not say the input was never
used, and does not promise an inference result.

## Lifetime and ordering

1. An immutable client message ID and content enter the durable Host queue before
   direct or queued steering reaches the native engine. Identity and model
   authority are rechecked at actual dispatch after asynchronous preparation.
2. A native acknowledgement advances admission independently of its history echo.
   The receipt can acknowledge Host custody immediately; native echoes refine it.
3. Exact terminal evidence closes attempts bound to that Turn, atomically with the
   terminal receipt. Closed messages are retained as Host-authored display content.
   They leave the active queue head without automatic retransmission.
4. New explicit user messages have new IDs and can proceed after this fence.
   Stopping alone never creates a new attempt for the old follow-up.
5. A definitively rejected stale-Turn steer retains queue custody for the next
   Turn. An ambiguous live attempt still fences dependent native dispatch; later
   user input can be accepted into the queue without pretending it was injected.
6. Repeating an already admitted message ID returns its existing receipt and
   never injects it again. Only definitive non-admission can permit a new binding
   of an existing queued message. A positive admission cannot be downgraded by a
   late timeout; a terminal Turn cannot be reopened by a late acknowledgement.

An idle Thread, elapsed time or missing history item is not a terminal receipt.
After a lost notification/restart the Host reads the exact bound Turn. Failure to
obtain authoritative history preserves uncertainty rather than inventing success.
Unknown target identity still requires reconciliation; this design does not claim
exactly-once external effects under arbitrary engine failure.

## Persistence and projections

Host storage migration 17 adds input receipts and immutable per-Turn terminal
receipts, plus an explicit `closed` queue state. Published migrations 1–16 remain
unchanged. The message row is still the only content and custody owner; related
facts share its transaction and survive process restart. Upgrade preserves legacy
message bytes and treats ambiguous legacy admission conservatively.

The optional protocol receipt flows through the Composer receipt, shared chat
runtime and user-message projection. A closed receipt retires optimistic command
ownership and fences stale streaming presentation for that exact Turn. It does not
change another active Turn. Receipt revisions reject older observations. Custody-
backed messages require exact identity for native echo matching, never equal text.

Closed messages are queried for loaded timeline Turns via `receiptTurnIds`.
Active queue work is not filtered by this scope. Indexed state/Turn queries keep
older closed receipts out of periodic queue maintenance. The Workbench refreshes
receipt scope at history-range changes, independently of token text deltas. Peers
without the additive receipt retain the legacy projection contract.

## Verification

Regressions exercise native admission, ambiguous admission, stop, lost terminal
notification, restart, late acknowledgement, stale receipt, rollback, migration
from v16, identical follow-up text, and a later independent user intention. They
assert retained content, no fabricated context adoption and no automatic replay.

`smoke-input-delivery.ts` renders the real shared runtime and UserMessage component
with synthetic state in desktop/390px touch contexts and both themes; it checks
status, draft retention, late receipts and overflow. The native smoke uses an
isolated real CLI and a local synthetic model, never production identity or paid
inference. Physical phone and deployed service checks are distinct release work.
