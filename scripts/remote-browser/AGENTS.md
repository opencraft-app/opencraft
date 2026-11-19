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
Agent operations automatically preempt human control; human input is retired at
the native control barrier before the Agent grant. Human takeover also cancels
old writes. Concurrent Agents cannot preempt each other.
The private Owner maps gateway request IDs to Worker IDs for cancellation and
advertises that capability. Older retained owners fail service invocation
explicitly; do not destroy their live tabs or invent a cancellation guarantee.

`tab-creation.mjs` commits page/tab/storage/binding identity, metadata revisions
and native capacity together before activation. Trusted execution/call identity
determines the creation key; retries retain that logical identity, conflicting
URLs fail, and retirement prevents resurrection. Post-commit failures report an
unknown outcome and direct callers to the tab directory. Native work never holds
the durable writer queue.
If a reported storage failure follows a known committed creation, restore
its memory/directory projection and notify clients before reporting the unknown
outcome with its tab ID. Do not activate or replay native creation from that catch.

`tab-close.mjs` admits conversation close through the same control queue. An
Agent may take over a human-controlled tab, but cannot cross a newer human takeover
between its grant and the durable close intent.
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
If metadata publication preceded a reported storage error, its retained
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
Direct Electron startup's shared Promise includes durable native reconciliation,
not only the ready event. All concurrent callers share its outcome. Fence the
process during publication and retire failed reconciliation before another start.
Native ready waits belong to the same startup failure boundary. Timeouts retire
the transport even without an exit callback; service close cancels the wait and
removes its deadline so old readiness cannot revive a retired attempt.
State loading is lifetime-bound: a closed service cannot initialize or acquire
the writer again through late metadata/catalog reads after shutdown has settled.

## Scale follow-up

- [x] Active-turn history observations bypass durable mutation custody. The
  private Host accepts only history/read and fences the retained route/generation
  before dispatch and before returning; mutations retain their durable receipts.
- [x] Retirement initialization uses one identity index instead of repeated scans.
  Legacy metadata snapshots use account-scoped, prefix-checked retirement cursors. Old
  clients receive complete facts; updated clients append deltas or replace after
  a prefix mismatch. Never trim permanent facts to reduce payload size.
- [x] Move browser durable state off whole-file JSON into a Worker-backed,
  transactional store. Preserve atomic creation/close/metadata/fact commits,
  writer ownership, recovery, and one-way legacy import before removing JSON.
- [x] Bound cold-client retirement delivery without losing offline draft fences;
  steady-state delta synchronization alone does not solve cold-start history size.

`state-store.mjs` keeps admission/reducers in the service queue and sends row
changes to `state.worker.ts`. Pages, metadata, close receipts and permanent
retirement identities commit together. Never serialize/clone all permanent facts
for an ordinary write. No-change reducers do not write SQLite. The retirement
index is updated only after the Worker commit acknowledgement; facts are monotonic.
SQLite failures stop the service. Unknown acknowledgements require reload, not a
native replay or main-thread SQL fallback. Drain the queue and close the Worker
before releasing the existing directory writer. Shared load cleanup runs once.

Legacy JSON is validated/imported once in the same transaction as its completion
receipt. Preserve the frozen source and verify it if still present. Missing SQL
with an installed identity must refuse reimport. Ship `browser-state-worker.mjs`
next to each bundled Headless/deployment gateway; source-only loader success is
not packaged acceptance. Maintain the registered migration schema and outcome.

Retirement scale: migration v2 indexes owner/kind/id in SQLite. Startup loads
active data and bounded close receipts, never the complete permanent archive.
Before a synchronous reducer, prefetch exact key facts/absence proofs plus
membership for current metadata and explicitly declared input/base values.
Unknown keys throw instead of silently passing a retirement check. Keep lookup
reads on the writer queue, and never replay a reducer to discover its read set.
Mutations that introduce resource keys must pass `keys`; metadata writes must
include new/base values in their selection. The archive and its identity index
update in the same SQLite transaction. Native admission uses async exact checks.

Modern metadata clients send reference queries including pending draft/base IDs
and one-time legacy import IDs. Responses contain only matching identities,
scoped to the authenticated owner. New IDs remain hidden in the storage read
projection until a complete authoritative snapshot admits them; retain raw drafts
for merging and retry. Never prune facts while allowing unknown optimistic IDs.
Older clients retain explicit full-history/cursor compatibility. Repeated normal
reads/writes must not accidentally use that compatibility path.

After atomic legacy import, rename the source to `tabs.imported.json` and sync
the directory. This optional archive is not read authority and need not be loaded
or rehashed on healthy restarts. A reappearing `tabs.json`, identity mismatch, or
missing SQLite with an installed identity/archive must refuse fallback/reimport.

Account metadata writes declare `ownerId` on the store transaction. The reducer
receives only that account's pages, metadata and receipts, with a detached draft;
foreign rows are rejected before commit. An in-memory owner index supplies the
read set, and retirement prefetch/delta comparison use that same scope. Global
capacity is captured from the owner-tree aggregate on the writer queue.

- [x] Remove foreign metadata cloning/serialization and retirement prefetch from
  ordinary account metadata writes; verify rejected drafts cannot cross owners.
- [x] Remove global array publication scans and narrow account resource reducers.
  Immutable owner-tree publication preserves old snapshots and caches whole-directory
  arrays only on explicit reads. Creation/reservation use the writer-queue capacity
  aggregate, including unknown native reservations.
- [x] Narrow checkpoint and global native-inventory reducers to resource rows so
  lifecycle reconciliation does not clone unrelated account metadata.

`account-directory.mjs` owns immutable account-tree publication and the occupied
resource aggregate. Account data is immutable after publication; reducers receive
clones. Capture global capacity on the writer queue, never before an await. Global
array projections are lazy snapshots; ordinary account operations must use
`store.account(ownerId)`, not materialize those arrays.

System checkpoint/startup/disconnect/inventory commits declare `resourcesOnly`.
They receive detached existing page rows and the queue-captured capacity, without
metadata, close receipts or retirement prefetch. Only runtime/URL/viewport/zoom
may change; identity, lifecycle, links, insertion/removal and other-table writes
are rejected. No-change reducers do not write or publish a replacement snapshot.
After acknowledgement, update only affected owner page arrays and preserve
metadata/receipt references. Failed commits leave directory/capacity unchanged.
The tree's page-count aggregate skips metadata-only subtrees for page projections.

Startup validation builds one account lookup before resolving legacy page links;
never perform a global account search for each resource. Initial retirement
prefetch covers existing resources and close receipts only. Defer account metadata
reference extraction/membership queries to its queued reads or scoped reducers,
which must retain current/input/base anti-resurrection fences.

- [x] Remove per-resource global account lookup and all-account metadata retirement
  prefetch from startup; verify deferred owner reads/writes still see tombstones.

- [x] Resolve bulk metadata/session links with one operation-local index rather
  than parsing/scanning pages, tabs and storage once per resource.

`sessionLinkIndex` is operation-local: reuse it across legacy page validation or
one metadata commit, never across mutable drafts. Preserve the first storage/page/
tab match and scope equality; malformed rows cannot admit later records past a
legacy null-record barrier. Normalize lease aliases once so a logical session
appears once in the directory. Single-resource admission retains `sessionLink`.

- [x] Detach runtime page projections and publish canonical committed bytes so
  live objects or retained reducer drafts cannot mutate the durable directory.

Before awaiting Worker commit, decode changed row payloads into detached
publication objects and clone retirement deltas. Publish those same encoded
values after acknowledgement, reusing unchanged rows. Never publish reducer-owned
references, including viewport objects assigned from a live page. Runtime pages
loaded/reconciled from the durable directory require detached nested fields.
Tests must mutate a live object/retained draft while acknowledgement is paused,
then compare the directory and occupancy with committed SQL rows.

- [x] Remove async cleanup's dependence on query-scoped retirement projections.

Retirement selections are reducer-local read sets, not durable service caches.
Do not acknowledge a committed close/discard by adding to those views after an
await: another account can replace the selection first. Accepted cleanup follows
committed page lifecycle/receipts. Creation failure reconciliation queries exact
retirement through the queued Worker operation if its resource row is gone;
failed lookup must preserve the original error and cannot authorize native replay.
Tests interleave foreign-account selection after publication and before normal
or failed continuations, including creation closed before its caller resumes.

- [x] Fence the Worker mailbox itself after its first fatal storage error.

The Worker retains its first fatal error and rejects every later business
operation, including messages already queued before the parent sees failure.
Only close may run afterward. Parent cleanup/termination is not the write fence.
A new Worker/database reopen is required for recovery; report the original unknown
outcome rather than executing later writes against a failed storage lifetime.
Protocol-level tests must queue rollback, write, read and close together and
verify the later write never reaches SQL.

- [x] Bound ordinary navigation/viewport/zoom checkpoints to declared resource keys.

`resourcesOnly` may declare `resourceKeys`, captured before queueing. Resolve those
keys through the account directory on the writer queue; a resource removed before
that turn is absent, never recreated. A reducer cannot enlarge its selected set or
change lifecycle/identity. Checkpoint timers coalesce only changed keys. Explicit
shutdown flushes and native inventory remain separate, deliberate full operations.

- [x] Expose service close as a shared drain barrier and await it in Headless
  before agent/store shutdown and root writer release.

`RemoteBrowserService.close()` returns its shared persistence/drain Promise.
Host composition must await it after closing browser capability consumers.
A resolved host close must imply Worker termination and browser writer release;
verify immediate successor load and do not treat fire-and-forget cleanup as drain.
