# V4 Replica architecture

OpenCraft's V4 Replica is an ordered, replayable state protocol with a durable
server journal distinct from V3 Resume pagination.
`@opencraft/appserver-replica` owns the shared authority/client state machine; `@opencraft/appserver-replica-storage-node` is the
server adapter, while Web and Expo provide client caches.

```text
command                         reconnect / live gap
  │                                    │
  ▼                                    ▼
ReplicaAuthority              ReplicaClient
  ├─ validate cursor             ├─ paint durable cache (not authoritative)
  ├─ dedupe commandId            ├─ subscribe before bootstrap
  ├─ allocate contiguous seq     ├─ replica/sync { epoch, nextSeq }
  ├─ materialize mutations       ├─ drain every delta page
  ├─ atomic persistent commit    ├─ atomically install snapshot on gap/epoch
  └─ publish replica/entry       └─ become live only after buffered replay
          │                             │
          └──── JSON-RPC / WebSocket ───┘
```

## Persisted authority state

| Field | Invariant |
| --- | --- |
| `epoch` | Identifies one linear history. Destructive replacement or rewind must rotate it. |
| `nextSeq` | The next sequence to allocate. The client cursor uses the same convention. |
| materialized entities | Exact state after every entry below `nextSeq`. |
| `journalStartSeq` | Earliest sequence still replayable. A cursor before it receives a snapshot. |
| Journal entries | Contiguous from `journalStartSeq` through `nextSeq - 1`. |
| command receipts | Durable `commandId` fingerprint and result used for idempotent retries. |

The authority commits all six pieces together before publishing a live entry.
A failed disk write therefore cannot expose an entry whose cursor disappears
after process restart. `JsonFileReplicaStorage` writes a sibling temporary
file, fsyncs it, renames it atomically, and fsyncs the parent directory.
Command receipts are not Journal cache and are therefore not removed by
Journal compaction. If a deployment needs receipt retention limits, it must
introduce an explicit idempotency horizon in a later protocol version rather
than silently weakening the current contract.

In a V4 deployment, one scope represents one `(hostId, replica namespace)`.
Its single `nextSeq` orders every entity kind in that namespace. It should not
be split into a separate authority per thread merely for UI convenience. The
per-thread scope used by `createThreadViewReplicaSource` is a V3 compatibility
projection because that legacy server exposes no host-wide Journal.

## Wire protocol

| Message | Purpose |
| --- | --- |
| `replica/sync` | Returns a bounded continuous delta, or a full snapshot when continuity cannot be proven. |
| `replica/mutate` | Applies a typed mutation batch with durable `commandId` idempotency and optional expected cursor. |
| `replica/entry` | Publishes one committed log entry after persistence. |
| `replica/snapshot` | Publishes an explicit destructive replacement/epoch rotation. |

The cursor is `{ epoch, nextSeq }`, where `nextSeq` is the exact next entry the
receiver requires. Duplicate entries have `seq < nextSeq`; an adjacent entry
has `seq === nextSeq`; anything larger is a gap. Catch-up is bounded but drains
until `hasMore === false`.

## Client phases

| Phase | May render? | Authoritative? |
| --- | --- | --- |
| `empty` | empty state | no |
| `painted` | persisted cache | no |
| `syncing` | cache plus committed progress | no |
| `live` | synchronized entities | yes |
| `offline` | last committed display | no |
| `error` | last committed display plus error | no |

Live notifications are subscribed before bootstrap and buffered until the
snapshot/delta commit finishes. A storage failure preserves the old visible
cursor; it never publishes an uncommitted state. Gap, epoch change, journal
compaction and server rewind all converge through the same snapshot install.

## AppServer V3 compatibility

The AppServer V3 compatibility path uses View hydration rather than server-side
`epoch/seq` Replica methods:

- `thread/resume` sends `excludeTurns` and optionally `initialTurnsPage`;
- Durable, Paginated and ordinary Tail history are selected after Resume;
- reconnect marks mounted conversations `needs_resume`.

`createThreadViewReplicaSource` therefore uses
`appserver-v3:<hostId>:<connectionGeneration>` as a compatibility epoch. Adjacent
local View revisions can feed the common ReplicaClient reader shape. They are
not V4 Authority sequence numbers. A missed revision or generation change
forces a snapshot because this V3 source exposes no retained server Journal
to replay.

The AppServer remains the business write authority in this compatibility path.
ReplicaClient is the UI's normalized materialized read model; calling it the UI
read authority must never be interpreted as upgrading a local View revision
into a durable server log.

Writes stay semantic: V3-compatible clients continue using AppServer
business commands (`thread/start`, send, cancel, approval, and so on). OpenCraft
does not pretend an arbitrary Replica mutation can be translated back into a
V3 command. A V4-native server uses `replica/mutate` and may project the same
domain commands internally.

## Replica synchronization invariants

- Complete paged gap recovery, atomic replacement for a true gap/epoch/rewind,
  and cached paint without synchronization authority.
- Classify stale, adjacent and gap sequences; reject non-adjacent older pages.
- Storage requires compound identity, atomic multi-row apply, host deletion
  and schema migration behavior.
- Keep late cache reads, live persistence and independently demanded replicas
  within their respective synchronization and storage owners.

These constraints apply to the domain-neutral entity log together with the
durable authority journal, expected-cursor writes and command receipts.

## Package boundaries

- `@opencraft/appserver-protocol`: wire types only.
- `@opencraft/appserver-replica`: renderer-neutral Authority, Client, router,
  AppServer source, Memory storage and Cordis registry.
- `@opencraft/appserver-replica-storage-node`: atomic server/Lab persistence.
- `@opencraft/appserver-replica-storage-web`: IndexedDB transaction adapter.
- `@opencraft/appserver-replica-storage-expo`: Expo SQLite exclusive-transaction adapter.
- `@opencraft/appserver-session`: AppServer V3 Resume/View adapter.

All three storage engines implement the same atomic ports; none defines an
alternate Replica model.
