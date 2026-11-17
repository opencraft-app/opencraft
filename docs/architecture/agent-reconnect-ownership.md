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

This change does not introduce deferred/private Thread publication, Hub ownership policy, sender admission
receipts, upload retry behavior or transparent turn retransmission. Those owners require their own coordinated
protocol and persistence changes. It also does not add an idle timeout that guesses when a used execution
lane can be discarded.
