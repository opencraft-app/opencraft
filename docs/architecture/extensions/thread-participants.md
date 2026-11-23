# Thread participants and creator grouping

`@opencraft/plugin-thread-participants` is the core owner of Thread participant
metadata: who created a Thread and which verified senders had a user message
accepted in it. It replaces the downstream identity plugin's private copy. The
identity product still owns who a sender is, how a photo is found and which
account the reader is signed in with.

## Ownership

| Concern | Owner |
|---|---|
| Verified sender of a submission (`MessageSender`, kind `employee`) | Host `ThreadIdentity` and the identity adapter that verifies the connection |
| Creator, presence and revision rows | `ThreadParticipantsMetadata` (`./server`), the only writer of the published tables below |
| Which Threads a reader may list | Hub `ThreadAccessSession`; it gates the `threadIds` of every request and the `threadId` of every notification |
| Batched reads, retry and connection fencing | `ThreadParticipantsController` |
| Title badge and participant popover | `createThreadParticipantsBadge` on the `threadBadge` channel |
| "By creator" mode and "My conversations" filter | `CreatorGrouping` on the `threadListGrouping` channel |
| Display mode menu, filter disclosure, group chrome | Shell sidebar (unchanged) |
| Photo URL for `(kind, name)` | The installed `identityAvatar` contribution, read through `useIdentityAvatarUrl` |
| The reader's account key and sender name | The identity product, through `ThreadParticipantsViewer` |

## Host side

`ThreadParticipantsMetadata` implements `ThreadMetadataExtension`. A deployment
installs it through its identity adapter:

```ts
createThreadMetadata: createThreadParticipantsMetadata(),
```

It writes the tables that already exist in both `thread-identity.sqlite` and the
local Host-state database. Their names keep the historical prefix
(`ioa_message_presence`, `ioa_participant_state`, `ioa_thread_creators`,
`ioa_presence_sync`); they are published storage contracts and are neither renamed
nor migrated. No schema change is involved.

- A participant is a verified sender whose user message was accepted: a
  successful `turn/start` or `turn/steer`, or a user item in a result or
  notification. A sender binding alone, a non-user item or an inherited (forked)
  message does not make anyone a participant.
- The first verified `thread/start`/`thread/fork` records the creator, including
  an anonymous `null`; a later claim cannot replace it. A fork starts without
  copied authors. `thread/delete` clears creator and presence and advances the
  revision so a reused ID never repeats one.
- Participants are ordered least recently active first. The revision advances on
  every visible change.

### Storage Worker

The provider never touches SQLite on the Host's network thread
(AGENTS.md “网络主线程不得阻塞”).

| Thread | Holds |
|---|---|
| Network (main) | A bounded projection of committed rows per Thread, the message IDs already committed, and the IDs in flight |
| `thread-participants.worker.ts` (`@opencraft/worker-owner`) | The only SQLite connection this provider uses: a WAL connection borrowed from the Host's already migrated database (`context.databasePath`). It reads verified senders and inherited-message marks from the same file and never creates, migrates or recovers it. |

- An observation of a message already in the projection costs no Worker call and
  no notification. Anything else is posted to the Worker without waiting.
- The Worker runs calls in FIFO order, each write in one `BEGIN IMMEDIATE`
  transaction. The main thread updates its projection from the acknowledgement
  and only then sends `changed`; announcements follow posting order.
- A read answers from the projection; cold Threads are loaded by a Worker call
  queued behind earlier writes.
- A rolled-back write announces nothing and is retried at the next observation.
  A Worker that crashes or reports a fatal error fences the provider: reads
  reject, observations are ignored, and nothing falls back to this thread.
- `close()` returns a Promise that resolves after every write posted before it
  committed; the Host awaits it before closing its own database.
- Bundled servers start `thread-participants-worker.mjs` beside the bundle
  (`scripts/packaging/owner-workers.mjs`). `config/main-thread-sync-io.json`
  lists `server.ts` as an entry, so any synchronous IO that reaches it fails the
  guard.

The Host's existing main-thread connection still records senders; with both
connections in WAL a Host write can wait up to its `busy_timeout` while a
participant transaction (a few statements) commits. That connection is
recorded debt of the Host, not of this provider.

### Interface change

`ThreadMetadataExtension.close()` may return a Promise, and
`ThreadMetadataContext.databasePath` names the database file so a provider can
borrow it from its own Worker. `ThreadIdentity.close()` is now async and the
Codex Host and the Headless identity overlay await it before closing storage.
Synchronous providers are unchanged. Observation methods stay synchronous and
must only enqueue.

## Wire contract

| Name | Shape |
|---|---|
| `opencraft/thread-participants/list` | `{ threadIds: string[] }` (1..100) → `{ data: ThreadParticipants[], errors: { threadId }[] }` |
| `opencraft/thread-participants/changed` | notification `{ threadId, revision }` |

`ThreadParticipants` is `{ threadId, revision, participants, creator?, pending? }`;
the client accepts exactly one outcome per requested Thread. The capability is
`extensions[method] = { version: 1 }`.

The names `opencraft/ioa/thread-participants/list` and
`opencraft/ioa/thread-participants/changed` are deprecated aliases. A Host serves
and advertises both names and sends both notifications by default
(`legacyAliases: false` turns the alias off). A client prefers the core
capability, falls back to the alias on an older Host, and listens only to the
notification that matches the method it uses, so a Host sending both does not
cause two reads.

Authorization is the Hub's: a batch containing any Thread the reader cannot
read is rejected with `THREAD_NOT_FOUND` before it reaches the Host, and change
notifications for such Threads are dropped. Shared Threads are readable by
admitted readers; a private Thread only by its creator.

## Client side

`registerThreadParticipants(api, { getClient, viewer })` registers the badge,
the participation overview used by Tasks and the creator grouping on the calling
trusted extension. The identity product registers its own `identityAvatar`
resolver; core never builds a photo URL.

- The badge consumes the shared `DisclosureButton`, `InlineAction` and Radix
  Popover. Mouse hover previews after a delay; click, tap or keyboard pins the
  popover. Loading, empty and failure use the popover's existing slots, and the
  last verified rows stay visible while refreshing or after a failure. A Host
  without the capability renders no badge.
- `CreatorGrouping` follows [collections](../../../design/ui/collections.md):
  the mode and the personal filter live in the Shell's existing display menu and
  filter disclosure, groups use the Shell's group chrome, and the reader's own
  group sorts first. A group carries `identity: { kind, name }`; the Shell
  resolves its photo through `IdentityAvatarContext`. Unknown, loading and
  unavailable creators have their own groups instead of disappearing.
- "My conversations" matches only positive evidence: authenticated creation
  (`createdByViewer`) or a verified creator/participant row. Unresolved and
  empty metadata do not match. A signed-out reader gets no filter descriptor
  and no unread membership.
- Mode, collapsed groups and the filter are stored per account in
  `api.localPreferences` under `thread-list.v1`; group IDs are
  `employee:<name>`. A storage failure keeps the in-memory choice and shows a
  notice instead of pretending it was saved.

## Verification

- `tests/identity/thread-participants-server.test.ts`: writes and reads in the
  published tables of both databases, restart, alias and notifications,
  creation/fork/delete, validation, cache eviction and rollback; no SQLite call
  on the main thread (prototypes throw there while the provider runs), commit
  before announcement in posting order, drain on close, and a crashing Worker
  failing closed.
- `tests/identity/thread-access.test.ts`: only readers can list or observe a
  Thread's participants, under both names.
- `tests/extensions/thread-participants-client.test.ts`: wire parsing, method
  fallback, participation overview, grouping, filtering and preferences.
- `tests/extensions/thread-participants-badge.test.tsx`: badge and popover
  rendering, states, resolver use and locale.
