# V4 Replica architecture

OpenCraft's V4 Replica is an ordered, replayable state protocol. It is not another
name for Codex Resume pagination. `@opencraft/appserver-replica` owns the shared
authority/client state machine; `@opencraft/appserver-replica-storage-node` is the
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
per-thread scope used by `createCodexThreadReplicaSource` is a V3 compatibility
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

## Codex V3 compatibility

The latest recovered Codex Desktop tree does not expose server-side
`epoch/seq` Replica methods. Its mature behavior is a View hydration protocol:

- `thread/resume` sends `excludeTurns` and optionally `initialTurnsPage` in
  `reference://codex/.runtime/source-tree-build-r1273-natural-startup-ownership/conversations/resume-thread-with-catalog-hydration-04170.js`;
- Durable, Paginated and ordinary Tail history are selected after Resume in the
  same module;
- reconnect marks mounted conversations `needs_resume` in
  `reference://codex/.runtime/source-tree-build-r1273-natural-startup-ownership/conversations/app-server-manager-class-04231.js`.

`createCodexThreadReplicaSource` therefore uses
`codex-v3:<hostId>:<connectionGeneration>` as a compatibility epoch. Adjacent
local View revisions can feed the common ReplicaClient reader shape. They are
not V4 Authority sequence numbers. A missed revision or generation change
forces a snapshot because Codex has no retained server Journal to replay.

The AppServer remains the business write authority in this compatibility path.
ReplicaClient is the UI's normalized materialized read model; calling it the UI
read authority must never be interpreted as upgrading a local View revision
into a durable server log.

Writes stay semantic: Codex-compatible clients continue using AppServer
business commands (`thread/start`, send, cancel, approval, and so on). OpenCraft
does not pretend an arbitrary Replica mutation can be translated back into a
Codex command. A V4-native server uses `replica/mutate` and may project the same
domain commands internally.

## Paseo evidence and adopted invariants

Paseo is used as behavioral evidence, not copied source:

- `/data/paseo/docs/timeline-sync.md` requires complete paged gap recovery,
  atomic replacement for a true gap/epoch/rewind, and cached paint without
  synchronization authority.
- `/data/paseo/packages/app/src/timeline/session-stream-reducers.ts` classifies
  stale, adjacent and gap sequences and rejects non-adjacent older pages.
- `/data/paseo/packages/app/src/runtime/replica-cache/row-store.contract.ts`
  requires compound identity, atomic multi-row apply, host deletion and schema
  migration behavior.
- `/data/paseo/packages/app/src/timeline/replica.test.ts` covers late cache
  reads, live persistence and independently demanded replicas.

OpenCraft generalizes those timeline rules into a domain-neutral entity log and
adds a durable authority journal, expected-cursor writes and command receipts.

## Package boundaries

- `@opencraft/appserver-protocol`: wire types only.
- `@opencraft/appserver-replica`: renderer-neutral Authority, Client, router,
  AppServer source, Memory storage and Cordis registry.
- `@opencraft/appserver-replica-storage-node`: atomic server/Lab persistence.
- `@opencraft/appserver-replica-storage-web`: IndexedDB transaction adapter.
- `@opencraft/appserver-replica-storage-expo`: Expo SQLite exclusive-transaction adapter.
- `@opencraft/appserver-session`: Codex V3 Resume/View adapter.

All three storage engines implement the same atomic ports; none defines an
alternate Replica model.
