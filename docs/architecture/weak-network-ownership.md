# Weak-network ownership

The physical route, logical Host and work item have independent lifetimes.
A socket being open never proves that a mutation was accepted.

| Owner | Authority | Recovery boundary |
| --- | --- | --- |
| Shared AppHost factory | Allocate physical sockets; admit retries with one backoff and jitter budget | Logical consumers cannot bypass admission or cancel a peer's connection |
| Host runtime | Initialize and restore its authoritative view | Uploads observe ongoing recovery rather than advancing its retry schedule |
| Conversation/outbox | Retain input custody and delivery evidence | Positive receipts reconcile unknown; missing history is never rejection evidence |
| Attachment Host | Validate sequential offsets and exact content replay | Advertised last-chunk replay, bounded in-process receipts; missing state rejects replay |
| Service Worker registration | Activate a complete build | Cache entries are staging until installation completes; incomplete builds never activate |
| Release supervisor | Serialize validated image transitions | Verify the actual live baseline, stop old owners, take cold backups, then replace and verify |

A message progresses from waiting to attempting and then accepted, definitively
failed, or unknown. Failed local rows do not block later independent waiting
rows. Explicit retry moves a failed row to the tail. Unknown remains a fence
until exact positive evidence or an explicit local stop-waiting action. The
latter does not cancel execution or authorize replay of the original identity.
Persistence failure retains custody and its fence. UI explains that the original
message may still arrive.

Upload progress is separate from Host acknowledgement. Smaller frames reduce
head-of-line blocking. A safe retry retains upload identity, offset, metadata and
content; it waits for the shared route and rechecks replay capability after
reconnection. Cancellation retires that upload's wait without closing the route.
Legacy Hosts are not retried. Receipts survive lost acknowledgements within the
Host process; process restart or expiry is a conservative failure, not a claim
of cross-process resumability.

Visible-page probes remain conservative because browser JavaScript cannot observe
partial incoming WebSocket messages. Background suspension does not consume a
foreground probe deadline. Connection status, progress and operation acceptance
must not be substituted for one another. Existing liveness bounds are not a
promise of instantaneous black-hole detection or physical-phone validation.

Offline navigation has an eight-second cached-shell fallback. Installation reuses
exact hashed public assets, retries individual downloads with a finite body/write
bound, and retains bounded staging for a later attempt. It keeps the active
complete build. Only a successful install can activate and retire prior caches;
account/API responses never become a cached navigation shell.

A release receipt names the selected committed consumer, upstream pin, assembled
source tree, runtime projection, rebuilt entries and unchanged image contents
separately. Later development commits may be integrated without being included
in the selected release. Equivalent compatibility patches can have different
context hashes; retaining the live patch plus an explicit refinement preserves
reviewable provenance without treating Git ancestry as runtime evidence.
