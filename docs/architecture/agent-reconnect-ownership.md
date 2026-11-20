# Agent reconnect ownership

The standalone AppServer owns the native Agent process and native WebSocket.
A Gateway/Host connection is a subscriber, not the owner of an admitted operation.
Generation routing is not required for this relay contract.

## Authority and identity

- Host owns submitted input identities, execution leases and reconciliation against native history.
  A transport error does not establish that execution failed.
- The native Agent owns execution and durable history. Ordinary `turn/start` and `turn/steer`
  are never automatically resubmitted by the callback relay.
- The callback facade owns explicitly replayable orchestration receipts for its process incarnation.
  A request ID correlates one wire response; an operation ID identifies a creation/name mutation.
  A fresh incarnation cannot confirm an operation from a previous AppServer process.
- Stream notifications are transient. Reconciliation, rather than universal event replay, restores projections.

## Explicit orchestration operations

Creation/name mutations register a receipt before asynchronous preparation. Preparation continues
independently of the current subscriber's disconnect. Retries with the same operation and arguments
join or retrieve that receipt rather than executing again. The intent digest includes the actual arguments
and caller fingerprint; object key order does not create a new intent and a reused caller fingerprint
cannot hide changed arguments. A subscriber's delivery failure cannot destroy the stored result or
prevent delivery to other subscribers.

Known preparation rejection and success are retained until acknowledgement. Proven pre-dispatch
failures preserve the public `notSubmitted: true` contract; uncertainty after forwarding does not. A forwarded operation's
observation deadline produces **result unknown**, not a rejection or permission to execute again.
It retains native correlation, refuses acknowledgement, and a confirmed late native result replaces
uncertainty for subsequent retrieval. Native connection loss also retains uncertain receipts in the
relay owner, independently of a replacement lane. Already rejected preparation cannot forward later.
These receipts are in-memory for this AppServer incarnation, not a durable cross-process operation log.

## Bounds and shutdown

The default observation deadline is 120 seconds; each lane admits at most 1024 requests, with at most
1024 retained operations and 32 pending subscribers per operation. Duplicate subscriber owner/request
pairs do not consume another subscriber slot. A timed-out, still-running preparation continues to consume
owner capacity until it settles. The policy API has no cancellation signal: this does not claim to cancel
underlying I/O. A saturated old preparation owner must still allow a new connection's initialization so it
can retrieve its receipt. Peer send queues are capped at 32 MiB; an over-budget peer is disconnected.
These are admission/count/transport bounds, not a byte-size guarantee for every retained native result.

Detached empty lanes may retire after 60 seconds only if all admitted native methods were known read-only:
`initialize`, `model/list`, `thread/list`, `thread/loaded/list`, `thread/read`. Pending reads, preparations,
receipts and callbacks prevent retirement. Human/tool callbacks and `turn/started` establish execution
ownership even on a previously read-only lane. Unknown methods conservatively pin the lane: an idle RPC
queue does not prove that native execution ended. There is a 32-lane/owner admission cap; unacknowledged
or uncertain receipts are never evicted just to admit more work.

## Private creation publication

Private creation publication remains separate from receipt delivery: successful
allocation does not publish a conversation before ownership commit. An uncertain
creation keeps its publication barrier closed. A known preparation rejection
releases its barrier without creating or publishing a conversation.

## Native connection replacement

A stable lane key selects a relay-owned operation owner. Receipts and the
private-publication identity belong to that owner, not either WebSocket.
Native socket loss retires transport correlation and callbacks, but preserves
confirmed receipts and publication rights. Reattaching the same lane can replay
a confirmed result and publish it after Hub ownership commit. An acknowledgement
does not remove an outstanding private-publication owner.

A request still preparing when the native channel dies is a confirmed rejection:
it was never forwarded, its unused publication barrier is released, and a late
policy completion cannot send it. The unresolved policy promise still consumes
the owner's admission capacity until it settles, including across reconnects.

A forwarded request without a confirmed result becomes resultUnknown. Replaying
its operation returns uncertainty; it cannot be acknowledged or executed again.
Without an authoritative native operation lookup this layer cannot reconstruct
a lost creation result. Its private barrier remains fail-closed and unknown IDs
may remain unavailable until authoritative reconciliation or native process
replacement. A reconnect or timeout alone is never evidence of rejection or
permission to publish. This is bounded in-memory fencing, not crash durability.

The relay bounds live lanes and retained owners to 32 each. Detached owners with
no receipts, publication allocations or preparing promises can be collected;
uncertain owners cannot be evicted to admit work. Native correlation IDs include
a connection nonce, preventing reuse when a lane's transport is replaced.

## Human interaction routes

The stable producer interaction key identifies an approval; its native wire ID
only selects the current route. Source loss suspends responses without resolving
the approval. A different stable key may reuse that suspended wire ID, but cannot
replace a live route. Old Turn completion retires only its own stable entries.
Modern Host adapters carry the stable key on responses; the facade rejects a key
from a replaced native connection and strips this metadata before native delivery.
Legacy unkeyed responses remain compatible and cannot provide that same identity
fence. Suspended interactions remain bounded by the existing 256-entry limit;
only authoritative native resolution/Turn completion retires them. No timeout
invents a human answer or claims an uncertain request was resolved.

Callback receipt handling does not replace Host sender admission, upload retry, or durable input-delivery owners. None of these contracts authorizes transparent retransmission of an uncertain Turn.
