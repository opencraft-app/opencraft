# Agent reconnect ownership

The standalone AppServer already owns the native Agent process and its WebSocket
connection. Gateway/Host replacement does not restart that process. Generation
routing is not required for this reconnect contract.

## Authority

- Host persists submitted input identities and execution leases. After connecting
  it reconciles unsettled inputs/turns against native history; a transport error
  alone is not evidence that execution failed.
- Agent/native owns execution and its durable history.
- The AppServer callback facade owns explicit orchestration receipts and pending
  callbacks for its process incarnation. Socket objects are subscribers only.
- Ordinary stream notifications are transient. History/state reconciliation, not
  a universal event replay log, restores the client projection.

A connection request ID correlates one wire response. An operation ID identifies
one explicitly replayable mutation. The AppServer incarnation fences old receipts
and callbacks after process replacement. Ordinary turn/start and turn/steer are
never automatically resubmitted by the facade.

## Operation lifecycle

Explicit orchestration creation/name mutations register one receipt before async
preparation. Preparation continues independently of subscriber disconnect. Every
known success/failure is retained and delivered to current subscribers; retries
with identical identity receive that receipt. Different arguments are rejected.
A completed receipt is removed only after acknowledgement.

The facade uses a 120-second observation deadline and a 1024-request per-lane
admission budget. A preparation that exceeds its deadline cannot subsequently
forward. Its still-running preparation retains a budget slot until it settles,
so a hung policy cannot cause unbounded new preparations. The policy API currently
has no cancellation signal; the facade does not claim to cancel underlying I/O.

A forwarded mutation exceeding the deadline is **unconfirmed**, not rejected. It
retains its bounded native correlation and receipt; acknowledgement is refused
until a native response confirms the result. Retries do not execute again. A late
response updates the receipt for subsequent retrieval. Ordinary RPC correlations
are removed at their deadline. Host execution reconciliation remains authoritative
for restoring turn state.

Private creation publication remains separate from receipt delivery: successful
allocation does not publish a conversation before ownership commit. An uncertain
creation keeps its publication barrier closed. A known preparation rejection
releases its barrier without creating or publishing a conversation.

## Resource boundaries

Operation receipts are limited to 1024 per lane and pending subscribers to 32 per
operation (duplicate owner/request pairs do not add subscribers). Peer send queues
are capped at 32 MiB; an over-budget peer is disconnected instead of buffering
indefinitely. Human interaction replay and native confirmation semantics remain
unchanged.

Detached lanes with no preparations, requests, receipts, callbacks or withheld
publication notifications retire after 60 seconds if they have only admitted
known read-only methods: initialize, model/list, thread/list, thread/loaded/list
and thread/read. Pending reads still prevent retirement. Human/tool callbacks
and turn/started establish execution ownership even on a read-only lane. Every
other method, including unknown future methods, conservatively pins the lane:
zero outstanding RPCs does not prove zero running turns. Full retirement of previously used lanes requires an
authoritative engine quiescence/detach contract; no idle timer guesses it here.
The existing 32-lane admission cap remains in place.

## Durability boundary

Receipts and callbacks survive Gateway/transport replacement while the AppServer
process lives. They are not a crash-durable operation journal. Agent process
replacement requires incarnation checking and persisted-history reconciliation;
it does not promise seamless continuation of in-memory approvals or running work.

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

Operation fingerprints bind the canonical method, arguments, caller identity and deferred-publication intent. Reusing a caller fingerprint cannot conceal changed arguments.
