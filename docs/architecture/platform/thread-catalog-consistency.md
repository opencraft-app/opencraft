# Thread catalog: ownership, evidence and projection

Status: **executable design with canonical projection and native-read confirmation implemented**. This contract is shared
by catalog consumers; product grouping and the Sidebar must not supply directory authority.
See [the executable models and reproduction commands](../../../specs/thread-catalog/README.md).

## Identity and the existing single-writer boundaries

The shared resource identity is the owning Server namespace + Thread ID. A second device or a
second authorized collaborator does **not** create a second Thread. A client replica/cache key is
separately fenced by its admitted account scope, connection Host/recipe incarnation and Thread ID.
Do not confuse replica identity with shared resource identity, or key either by title/page/position.
Host routing and authenticated server origin remain their existing owners; do not conflate them
or use a shortened display ID.

| Concern | Durable/evidence owner | Client role | Not allowed |
|---|---|---|---|
| Name / archive / existence | Native Thread lifecycle, projected through authorized directory | Apply the relevant field mutation; retain receipt-scoped intent until reconciled | Rename must not replace pin/status/clock; omitted row is not deletion in a partial directory |
| Pin | Native pin/section owner (`opencraft/thread-pins/*`, native section bridge or engine pin store) | Read independent pin evidence; expose known pinned / known unpinned / unknown | A recent-page duplicate without pin metadata cannot cancel a pin |
| Runtime status | Native engine lifecycle / admitted execution events | Apply status without fabricating a directory row or chronology | Stale metadata cannot override a newer execution fact merely by arriving last |
| Recency | Native Turn clock, current shared recency projection | Preserve native activity ordering | Rename, read, resume and packet arrival are not new activity |
| ACL / visibility | Server admission/policy and scoped route owner | Filter only within admitted scope; retire denied/revoked data immediately | Retention must never resurrect a revoked scope or infer authorization from a cached row |
| Commit notification / fanout | Server catalog publisher and existing admitted connection fanout | Consume the notification independently on each device; repair missed observations with admitted reads | A local mutation receipt or local query invalidation is not cross-device delivery |
| Page members / cursors / coverage | Authorized directory read | Cache the query's pages, preserve continuation/coverage | Page position is not a field version; missing from a partial page is not removed |
| Pending name / pin command | Existing title/pin writer (temporary intent only) | Paint the desired value and track committed / failed / ambiguous outcomes | No replay of ambiguous mutations; no second durable client truth |
| Grouping and ordering | Pure presentation over the resolved view | Derive Pinned / Recent / Mine consistently | Filter/group code must not repair or persist entity facts |

The metadata snapshot, pin snapshot, execution fact and pending intent have distinct evidence.
A legacy normalized `pinned:false` on a recent row is especially dangerous: it looks like a
negative fact but can merely mean this page did not carry the separate pin projection.
A **complete admitted pin snapshot** can establish unpinned membership; a missing pin field or
incomplete/unknown pin read cannot. Directory completeness alone is not pin completeness.

## Logical normalized view, not another writable store

Keep the existing QueryClient owner of raw pages and the existing bounded event journal / command
writers. Construct **one logical entity view per identity** before grouping. This does not require
another global store, a second timeline, local database or copied lifecycle implementation.

The composition is:

```
admitted page membership + field-owner evidence + unacknowledged deltas + scoped command intent
                      -> one catalog projection -> all navigation/grouping consumers
```

Initial rendering, incremental rendering and cache materialization must use the same canonicalization
and field-merge laws. For the existing legacy overlap path, first-occurrence wins is the minimum
compatibility rule because page 1 backfills native pins. It is **not** a general freshness order for
all fields or an excuse to ignore a later authoritative server fact.

1. Canonicalize duplicate identities consistently before applying changes. Do not flatten every page
   into `new Map(rows.map(...))`: that silently assigns authority to the last duplicate.
2. A patch can change only its declared owner fields. Materializing a patch for B must preserve every
   unrelated field of A, even when raw pages contain A more than once.
3. Distinguish absent/unknown from an explicit false, null or tombstone. Do not invent values to satisfy
   a broad generated Thread type, then treat those defaults as authoritative evidence.
4. Accept stale/deduplicated responses only under their exact admission/incarnation fence. Different
   publisher sources or scopes do not acquire a total order through timestamps or arrival sequence.
5. Bound temporary retention by the existing resource lifetime. A confirmed removal/revocation takes
   precedence over retained presentation. Restore/unarchive requires new authoritative evidence.

## Collaboration and independent device replicas

The synchronization path is **commit at the resource owner -> Server catalog notification -> all
admitted catalog readers -> each device's independent query/journal -> local grouping**. Directory
subscription is not a Thread View/execution subscription: a second device need not open/resume the
conversation to receive a rename. Do not broadcast the optimistic draft as committed state.

The existing `ThreadCatalogPublisher` already separates committed native lifecycle results from
catalog observations. The engine Host fans out to its initialized catalog clients; the Codex adapter
fans out to initialized clients, with existing access-control projection responsible for admission.
Keep those owners. A frontend event bus, BroadcastChannel or source-tab cache invalidation is not
a replacement for multi-device/server-mediated synchronization or authorization.

- Shared facts (name, lifecycle, membership/access changes) reach every authorized replica, not only
  the source device or currently opened Thread. A failed mutation must not publish a committed fact.
- Account-scoped preferences synchronize only through their existing account owner to that account's
  devices; device-local expansion/scroll state does not become a collaborative setting. Pin semantics
  follow the existing native pin/section owner; this model **does not silently redefine native pins
  as actor-private or universally shared**. Compare two replicas only when they consume the same
  admitted pin owner/scope.
- A command receipt confirms the source's write, not another device's observation. Sending to an
  eligible connection is also not an application-level acknowledgement. Lost/offline observations
  require an admitted snapshot/catch-up; do not resend the mutation to repair a reader.
- Per-device pages, pending intent, coverage and observation cut are independent. A single shared
  frontend cache in a test cannot establish multi-device convergence. Different page layouts must
  resolve the same owner evidence identically.
- Revocation wins over retention. Drop the revoked replica's retained data and reject its delayed
  frames/responses. Never fan out hidden metadata first and rely on the Sidebar to hide it later.
- Preserve per-incarnation event ordering or explicitly reconcile gaps. A global publisher sequence
  is not interchangeable with per-field versions: arbitrary out-of-order partial deltas cannot be
  made correct merely by discarding every sequence below the maximum. Reconnect/snapshot alignment
  must be specified before claiming arbitrary reordered transport is supported.

`CatalogCollaboration` checks 2 independent client replicas of one shared field, publication to all
admitted recipients, dropped events/disconnection, stale reads, revocation and conditional eventual
catch-up. Its publication watermark records fanout intent to admitted connected readers, **not guaranteed
network delivery**. Offline recovery comes from the committed owner state; do not add a fictional
per-device durable broadcast queue or require delivery to a nonexistent connection.
Refresh fairness assumes a healed network and current admitted owner data. It does not model the
whole WebSocket protocol, real ACL implementation, preference replication or multiple actors' pin
semantics. The two-device component fixture uses actual publisher/notification/cache code with
synthetic fanout/admission ports; it is not physical-device or production WebSocket verification.

## Acknowledgement is a proof obligation

`ThreadCatalogUpdates.markRead()` records a **client-local** start boundary. It can identify facts
that arrived after a read began. It cannot establish that a read which began later observed those
facts in an eventually-consistent directory index.

Retire an overlay only with evidence attributable to its owner and scope: a comparable same-owner
revision/watermark covering it, or a narrower admitted field-value confirmation for that particular
confirmed write. A missing/lagging field, partial directory, later response time, successful RPC,
or a client-materialized projection cannot certify arbitrary server observation. In particular,
a projection must not acknowledge itself just because its local sequence is current.

Current v1 messages carry publisher incarnation/revision for events, but not a universal comparable
snapshot revision for every metadata/pin/status path. Do not silently add an invented global version.
Choose owner-specific confirmation where available, otherwise explicitly retain/re-read under the
existing fences or extend the owner protocol with reviewed compatibility. The TLA+ owner revisions
are an **abstract evidence requirement**, not an implemented new wire field.

## Invariants and acceptance scenarios

- **Identity/scope isolation:** a different owning Server namespace makes the same Thread ID a
  different resource. A different account/admission/connection makes a different replica boundary,
  not a new shared Thread; retired responses cannot populate its current projection.
- **Unrelated-row preservation:** mutating B cannot regress A's pin/name/status/native clock.
- **Field ownership:** rename touches name; status touches status; pin touches pin. Any additional
  derived changes require their own authoritative evidence.
- **Cross-device publication and convergence:** one committed shared mutation is published to all
  admitted catalog readers; independent replicas at the same owner cut converge, including offline
  catch-up without mutation replay. Revoked replicas must never regain retained data.
- **Overlap consistency:** duplicate rows cannot change resolved identity facts depending on whether
  the view is rendering, materializing, paging or refreshing.
- **Monotonic evidence:** an old response cannot supersede a newer admitted fact of the same owner;
  duplicate events are idempotent. This is not a total order across independent owners.
- **No phantom deletion/unpin:** omission is meaningful only with the applicable complete admitted
  owner snapshot; a revoked owner/scope is not eligible for display retention.
- **Conditional convergence:** after mutations stop, admission remains valid and authoritative reads
  eventually succeed/catch up, the logical view converges. No liveness promise during permanent
  partition, endless writes or revoked admission.

Exercise page overlap + rename/status/archive; repeated pin/unpin + rename + failed/ambiguous ACK;
stale reads before/after events; tail pages arriving after first page; partial/empty reads; same ID
on different Hosts; account and connection switches; remove followed by stale replay and authorized
restore. Property tests should compare permitted interleavings at the **same authoritative cut**, not
assert that different cuts or incomplete reads necessarily have identical membership.

## Implemented remediation and remaining evidence limits

1. `project()` and `materialize()` reuse the same first-occurrence canonicalization as page rendering;
   an unrelated mutation cannot replace the authoritative pinned backfill with a stale duplicate.
2. Acknowledgement uses private native read evidence captured before projection. A local start cut is
   only a race fence: a matching owner field value must additionally confirm a patch/creation.
   Removal requires a complete admitted directory across all native pages; partial/warming/error
   reads and tail-page absence cannot certify removal. Cache folds never acknowledge themselves.
3. Cache folding is structurally stable and the hook does not write unchanged data, so retaining a
   fact while an index lags cannot create a render/refetch loop.
4. The existing Host connection recovery owner retires the previous connection's observations before
   healed reads. It first folds the displayed values into the existing cache, preserving display
   continuity; native Turn clock floors remain. New admitted reads can then observe mutations missed
   during disconnection rather than being masked forever by an old event overlay. Thread View
   mounts do not reset these observations; old in-flight reads are cancelled by that same owner.
5. Two independent-device tests cover different page layouts, committed broadcast, duplicate
   delivery, offline catch-up with a previously pending fact, and revocation. They use actual
   components with synthetic admission/network ports; real transport and physical clients remain
   separate deployment acceptance obligations.

The actual-cache chaos suite and former defect traces now require preservation. Bounded specs and
negative model controls remain; they are not implementation refinement proofs. The v1 protocol
still has no universal comparable snapshot revision: same-connection acknowledgement uses a narrow
field-value witness, while reconnection starts a new observation window. This does **not** establish
arbitrary unordered partial-delta transport safety or globally monotonic reads from every native
index. Those stronger guarantees need owner-protocol evidence, not a frontend clock.
