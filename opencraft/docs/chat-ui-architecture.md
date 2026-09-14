# ChatUI integration architecture

## Target

OpenCraft uses the latest Codex AppServer `Thread -> Turn -> Item` protocol. The
AppServer remains the business write authority. ChatUI consumes one normalized
Conversation Read Model: a V4 ReplicaClient for a V4-native Authority, or a
snapshot-oriented compatibility projection for Codex V3 Resume. Web and Native
surfaces share identity, projection, runtime commands, Composer documents and
design tokens. They do not share a renderer or editor implementation.

```text
WebSocket / Replay Transport
          |
Codex AppServer protocol
          |
Conversation Read Model
V4 ReplicaClient or Codex V3 compatibility projection
          |
Conversation Runtime
          |
Thread/Turn/Item -> Timeline Frame -> Timeline Block
          |
Web renderer                         Native renderer
          ^                               ^
ProseMirror adapter                 Native editor adapter
          |                               |
        Composer Document / Draft / SubmitIntent
```

## Non-negotiable boundaries

DSH terminal adaptation follows the HyperNode reference contract: completion,
interruption and failure notifications are lifecycle summaries (`itemsView:
"summary"`), never empty full Item snapshots. Full membership belongs to
history reconstruction. Visible reasoning, assistant and tool Items settle
before the Turn; only explicit completed output receives final-answer phase.
Aborted/interrupted runs retain partial output with final-answer phase, blocked/max-token/unknown
terminal reasons fail closed, and failures emit a typed error before completion.
The same terminal policy is consumed by live and history projection.

The source implementations live in `apps/local-agent-host/src/hypernode/`:
TurnManager, DSH tool projection and the engine event/terminal core.
`dsh-execution-record.ts` supplies local clock, replay-stable unique Item
allocation, notification and synchronous pacing ports. One ordered ledger is
used for live snapshots and native history replay, including active reasoning.
The local HTTP/mux transport, product-owned models and credentials remain host
ports; HyperNode SSH tenancy and per-workspace process launch are not local
execution policy. See [migration contract](../design/dsh-engine-migration.md).

1. A conversation is identified by `(hostId, threadId)`. A bare `threadId` is
   not a cross-host identity.
2. React components never import a WebSocket, JSON-RPC client, Electron bridge,
   Session View store or Replica Journal entry.
3. `appserver-session` may translate Codex V3 Resume/history into the common
   reader contract. Its local View revisions are snapshot continuity hints,
   not a server-sequenced V4 Journal.
4. A Transcript, Timeline Frame and Timeline Block are disposable projections.
   They never become a second persistence authority.
5. ProseMirror and Native editor documents are adapters. Persisted drafts use
   `ComposerDocument` from `@opencraft/composer-core`.
6. Submission freezes an immutable `SubmitIntent`; no UI calls
   `send(blocks): boolean` in the final architecture.
7. Unknown AppServer Item types render an explicit fallback Block. Protocol
   growth must not blank the conversation surface.

## Package ownership

The Composer permissions menu contains only declared permission profiles, without
an AppServer-default row or explanatory question. An absent or null draft choice
inherits the runtime's effective profile for display only; rendering never writes
that derived value into the draft. Until resolved, the trigger reads `Permissions`
and no profile is checked. Explicit choices still use the existing submit path.

Temporary Side Chat forks are adopted by `ThreadResumeCoordinator.adoptFork` from
the validated `thread/fork` response in its original connection generation. They
use the same metadata/notification projectors and Replica reader, but never issue
a rollout Resume or persistent queue query. Their history source is `fork` and a
lost connection expires that temporary baseline. See the [workspace design](../design/README.md).

| Package | Owns | Must not own |
| --- | --- | --- |
| `appserver-protocol` | JSON-RPC methods and Thread/Turn/Item wire types | UI state |
| `appserver-client` | connection and request lifecycle | conversation projection |
| `appserver-replica` | cursor, persisted replica, catch-up and mutation receipts | React |
| `appserver-session` | V3 Resume/history compatibility and normalized reader source | final ChatUI snapshots |
| `chat-core` | identities, Frames, Blocks and pure projector registry | transport and React |
| `chat-runtime` | Replica-derived snapshots and command/history ports | protocol storage and rendering |
| `composer-core` | portable document, draft, target and submit intent | DOM/Native editor state |
| `codex-composer` | Web ProseMirror adapter and Codex visual surface | authoritative drafts |
| `timeline-virtualizer` | Codex Turn window, restore, geometry, follow and response-spacer policy | DOM and React Native |
| `workbench-runtime` | per-Host runtime, Thread catalog, Replica/Session lifecycle and commands | platform views |
| `workbench-web` | DOM Timeline, ProseMirror adapter and precise Codex frame | JSON-RPC storage |
| `workbench-expo` | RN Timeline, Native editor adapter and iOS/Expo Web frame | DOM |

## Current migration ledger

### Established

- AppServer client, WebSocket, memory and Replay transports.
- Resume strategies for legacy, tail, paginated and Durable history.
- V4 Replica authority/client/storage primitives and V3 compatibility source.
- Cross-host `ConversationKey` and opaque Turn/Item identities.
- Extensible Timeline projector registry with an unknown fallback.
- User, assistant, event and interaction Frames.
- Typed Blocks for text, reasoning, execution, patch, tools, plan, todo,
  subagents, approval, question, errors, compaction and images.
- Portable Composer Document/Draft/Target/SubmitIntent and target-scoped drafts.
- A Conversation Runtime that derives its snapshot from a Replica reader only.
- `AppServerWorkbenchRuntime` with per-Thread Replica clients, typed command
  ports, reconnect and stable Thread selection.
- Real WebSocket bootstrap for Web and Expo; IndexedDB on Web and Expo SQLite
  on Native cache only painted state beneath Replica authority.
- Web ProseMirror and Native input adapters controlled by the same
  `ComposerController`; submission freezes an immutable `SubmitIntent`.
- A typed Composer-to-AppServer compiler for new/fork/turn/steer/queue,
  interrupt, approvals and questions.
- Web and RN Timeline renderers consuming the same Turn/Frame/Block projection.
- Codex `VirtualizedTurnList` constants and algorithms: one full-height list,
  Turn-count overscan, measured-height anchor compensation, route restore,
  common geometry/scroll API, and parent latest-Turn follow reducer.

### Compatibility boundary

- `appserver-session` currently materializes a Thread View before exposing it
  through the ReplicaClient-shaped reader. This is the compatibility ingestion
  boundary, not proof that Codex V3 has a V4 Authority or retained Journal.
- `DisplayTurn` remains exported only for older fixtures. Neither application
  host uses it as its conversation read model.
- Browser attachment blobs require an injected upload/asset bridge before they
  can become server-readable AppServer attachments. The compiler fails closed
  when that bridge is absent.

### Production hardening, not architecture blockers

- Implement a fully rich Native text editor adapter rather than flattening rich
  display into the current native text-input surface.
- Add a production upload/asset host for browser and Native attachments.
- Tune platform-specific response-spacer animation curves while retaining the
  shared Codex placement and follow state machine.
- Split the large desktop renderer chunk at explicit capability boundaries.

## Evidence required for completion

Both apps have removed `createDemoWorkbenchRuntime`. Deterministic Memory and
Replay suites cover create/list/resume/page/send/stream/interrupt/retry,
interaction RPCs, cursor gaps and reconnect. The live 9988 gate deliberately
uses the existing canonical Thread read-only: it proves WebSocket → Session →
Replica authority, forced disconnect, reconnect and same-Thread recovery
without mutating a user's conversation. Production Web, Expo Web and iOS
bundles are independent quality gates; a static fixture alone is not accepted.
