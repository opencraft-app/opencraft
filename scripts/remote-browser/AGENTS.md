# Remote Electron host

Worker owns native pages, persistent partition identity and per-page control
ordering. The gateway owns authenticated grants and session routing. Viewer
visibility/media are presentation concerns, not automation authority.

Shared CDP implementation belongs in `packages/browser-cdp`; this folder adapts
native pages, existing control tokens, device settings and production demand.
Preserve the private owner transport and immutable runtime packaging. Do not
introduce a public debugger listener or a second page owner.

- [x] Remove PreviewBridge execution only after the CDP replacement passes real
  native-input and frame/navigation tests.
- [x] Invoke existing live tabs without a viewer through `automation-service.mjs`,
  preserving account/Host/Scope checks and the same control arbitration.
- [x] Cancel native requests across gateway/Owner/Worker identities, including
  queued work, control loss, viewer detach and gateway disconnect.
- [x] Capture screenshots under a bounded drawing lease through the service entry.
- [x] Wire existing tabs to the platform capability provider and execution grants.
- [x] Recover committed logical tabs and expose navigation through the service entry.
- [x] Create logical tabs atomically with directory/metadata revisions and notify
  connected clients without overwriting their pending edits.
- [x] Add service-owned close with committed retirement, native confirmation,
  client projection removal and bounded conversation-scoped close receipts.
- [x] Run the browser provider through real Codex CLI/MCP and packaged Electron;
  use isolated synthetic inference/authority and record that acceptance boundary.
- [x] Verify native Codex multi-turn admission through persisted local human
  authority and Worker SQL, including other-conversation denial and revocation.
- [ ] Add explicit foreground presentation, then verify
  durable receipts/cancellation through every supported harness.

The service entry accepts trusted bindings only. It requires a committed metadata
link, never creates a fake viewer or changes a live tab's visibility.
`page-lifecycle.mjs` owns native activation/recovery shared with real viewers;
both acquire the same per-page slot. Unknown creation outcomes are reconciled
by snapshot or positive absence before recreation. Recovery preserves native
partition identity and saved URL/zoom/viewport without changing metadata CAS.
Service agents cannot preempt a human; a human takeover cancels old writes.
The private Owner maps gateway request IDs to Worker IDs for cancellation and
advertises that capability. Older retained owners fail service invocation
explicitly; do not destroy their live tabs or invent a cancellation guarantee.

`tab-creation.mjs` commits page/tab/storage/binding identity, metadata revisions
and native capacity together before activation. Trusted execution/call identity
determines the creation key; retries retain that logical identity, conflicting
URLs fail, and retirement prevents resurrection. Post-commit failures report an
unknown outcome and direct callers to the tab directory. Native work never holds
the durable writer queue.
If atomic replacement publishes creation before a directory-sync failure, restore
its memory/directory projection and notify clients before reporting the unknown
outcome with its tab ID. Do not activate or replay native creation from that catch.

`tab-close.mjs` admits conversation close through the same control queue. An
Agent cannot close a human-controlled tab or cross a preceding human takeover.
`tab-retirement.mjs` owns retirement for service close, viewer close, discard and
legacy storage removal. Intent commits remove all logical references, record
retirement facts and prevent recreation before native cleanup. Accepted cleanup
survives execution cancellation/revocation/disconnect and storage errors after
publication. Rejected drafts do not schedule cleanup. Native ACK (or previously
confirmed absence) permits the completion commit to release capacity. Unknown
ACK keeps its reservation. A dormant close never creates a native page.

Close receipts retain the most recent 256 completed entries per account within
512 KiB, plus unresolved intents. Scope/Host/Thread remain required for receipt
reads. `retirement-facts.mjs` retains minimal page/tab/lease identities separately
in permanent `retiredResources`; receipt compaction must not delete these facts.
They protect metadata as well as physical residency. Loading old state seeds
facts from retained receipts and recovers compacted service IDs from their leases;
unrecoverable legacy IDs still retain the permanent lease fence. An older
unprovable close is denied. Projection reads do not mutate durable state.
Do not replay native input.

Metadata subscribers receive owner-scoped invalidations after creation/retirement commits.
New clients send a base value with each write. The shared record merge preserves
disjoint changes and rejects same-record conflicts; legacy clients keep strict
key CAS. Client writes and full-snapshot reads share ordering; partial key ACKs
must never publish an incomplete dependency graph. Pending edits survive reads
and failed merges. Reconnect rereads committed state, without replaying input.
Retirement filters remove only the closed identities from pending/stale metadata.
Clients drop those page/tab/panel/surface projections without another destroy
request or a metadata write; surviving pages and drafts remain in place.

`capabilities.ts` adapts the neutral catalog to session capabilities and keeps
text/image outputs distinct. It declares background open and tab operations, including
navigate/back/forward/reload/stop/close. Navigation returns acceptance, not page-load
completion. Its old document is checked at native dispatch; only that admitted
navigation can cross the document replacement it triggers. Queued old actions
still expire, and control loss/explicit cancellation still cancel navigation.
The Worker advertises navigation at startup; the private Owner forwards that
fact. A retained older runtime fails before dispatch and keeps its live pages.
Trusted `execution-grant.ts` resolves the admitted human and exact active native Turn;
the adapter imports no engine implementation. The headless composition owns
registration and closes consumers before the native service. Scope links come
from committed account metadata, including canonical conversation aliases.
Native liveness is checked on admission and every 500 ms during a call; account,
resource and document/control guards remain synchronous across native waits.
The Codex Bridge adapters must preserve the latest-Turn query's limit, sorting,
cursor and lightweight view. Do not mask a dropped limit by weakening admission
to accept the first row of an arbitrary history page.

Metadata writes retain a bounded retry-receipt cache and a durable compaction
revision fence. A merge whose receipt is absent and base revision predates that
fence must fail with STATE_CONFLICT; it must never silently replay an uncertain
old edit. Keep retained receipt lookup ahead of this fence and preserve the fence
through service-owned creation/retirement metadata updates.

Every newly committed metadata write must invalidate authenticated peers for its
owner after commit/projection reconciliation, including ordinary edits. Reads,
receipt replays and rejected drafts do not produce metadata invalidations.
If metadata atomic replacement published before a storage error, its retained
mutation receipt proves publication: reconcile memory and notify peers, and keep
committed retirement cleanup owned by the service. Report the error as an unknown
outcome; never apply those effects to a rejected draft.
Unknown-page snapshot reconciliation must fence Owner identity, page record and
runtime epoch across every native/durable await, including positive absence.
A stale reply cannot publish liveness or trigger close against a replacement.
Failure cleanup uses the original Owner/page/epoch too: recheck after durable
unknown-state publication before closing, and after close ACK before publishing
absence. Cleanup from one native generation cannot close or free another's slot.
Owner inventory reconciliation must validate its captured transport before and
after native cleanup and inside durable publication. Disconnection cannot turn
unknown reservations into absent merely because memory liveness was reset.
Failed post-attachment inventory recovery must release that exact Gateway transport
and reset provisional liveness/control. Preserve native pages and unknown capacity;
a later attachment must be able to reconcile them without a leaked exclusive peer.
Startup must recheck service lifetime after asynchronous preparation and before
spawning Electron or attaching Owner. Shutdown must not be followed by an
unowned late child whose startup resumed after resources were already released.
