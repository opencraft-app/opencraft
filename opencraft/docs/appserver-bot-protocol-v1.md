# OpenCraft AppServer Bot Conversations Protocol V1

Status: **implementation baseline**  
Wire protocol: **JSON-RPC 2.0 over WebSocket**  
Extension identifier: **`vela/bot-conversations`**  
Version: **1**

This document freezes the first implementable Bot and group-chat protocol for
OpenCraft. It is intentionally engine-neutral. Hermes, DSH, Codex, and future
engines are adapters behind an AppServer handler; none of their private types
appear on the wire.

## 1. Ownership boundaries

The ownership chain is:

```text
BotChatView
  -> Cordis BotConversationService
  -> AppServerBotConversationClient
  -> bot/* JSON-RPC methods
  -> AppServer BotConversationHandler
  -> engine adapter (Hermes/DSH/Codex/...)
```

For the temporary browser implementation, the handler may live in the browser,
but requests must still pass through the same protocol codec and handler
interface. Moving it to a server later must not change the UI-facing service.

The following ownership rules are normative:

1. The AppServer Host owns authoritative Bot, Conversation, Message, Execution,
   Interaction, and Routine state.
2. The Renderer owns only view state, drafts, focus, selection, animation, and
   disposable caches.
3. `BotConversationService` is a Cordis domain service. It must not import
   Hermes, TAT, Electron, IndexedDB, or React types.
4. A WebSocket connection is already scoped to one Host. Bot payloads must not
   repeat `hostId`; the outer `HostRuntimeRegistry` owns Host routing.
5. A Bot Conversation is not a Codex Turn. Messages and Executions are separate
   durable entities, and Presence is an expiring observation.
6. UI components never invent authoritative Messages or Executions. Optimistic
   state is identified by client IDs and reconciled with server receipts.

## 2. WebSocket framing

Each WebSocket text frame contains exactly one UTF-8 JSON object.

New Bot protocol frames always include `"jsonrpc":"2.0"`.

### 2.1 Request

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "method": "bot/conversation/read",
  "params": {}
}
```

`id` is a string or number and is echoed unchanged in the response.

### 2.2 Success response

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "result": {}
}
```

### 2.3 Error response

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "error": {
    "code": -32049,
    "message": "Bot backend is unavailable",
    "data": {
      "code": "BOT_BACKEND_UNAVAILABLE",
      "retryable": true
    }
  }
}
```

### 2.4 Notification

```json
{
  "jsonrpc": "2.0",
  "method": "bot/message/delta",
  "params": {}
}
```

Notifications have no `id` and receive no response.

### 2.5 Wire rules

- JSON-RPC batching is not supported in V1.
- Binary WebSocket frames are not supported in V1.
- IDs are opaque, non-empty strings. Clients must not parse them.
- Cursors are opaque strings. Clients must not construct or compare them.
- Times are Unix epoch milliseconds stored as integers.
- Unknown object fields are ignored for forward compatibility.
- Missing or invalid required fields fail with `-32602`.
- Servers must preserve request ordering only for requests processed on the same
  connection; clients must not assume response ordering.

## 3. Capability negotiation

The client advertises support through the existing `initialize` request:

```json
{
  "jsonrpc": "2.0",
  "id": "initialize-1",
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "opencraft-workbench", "version": "0.1.0" },
    "capabilities": {
      "extensions": {
        "vela/bot-conversations": { "version": 1 }
      }
    }
  }
}
```

The initialize result gains an optional `capabilities.extensions` field:

```json
{
  "jsonrpc": "2.0",
  "id": "initialize-1",
  "result": {
    "serverInfo": { "name": "opencraft-appserver", "version": "0.1.0" },
    "capabilities": {
      "extensions": {
        "vela/bot-conversations": {
          "version": 1,
          "topologies": ["direct", "group"],
          "features": {
            "messageStreaming": true,
            "executionCancellation": true,
            "attachments": true,
            "interactions": true,
            "botManagement": false,
            "botAssets": true,
            "groupMembership": true,
            "configuration": true,
            "routines": true
          },
          "limits": {
            "maxPageSize": 100,
            "maxInlineAttachmentBytes": 10485760,
            "maxParticipants": 32
          }
        }
      }
    }
  }
}
```

If the extension is absent, the Host does not implement Bot Conversations. The
product must show an unavailable state; it must not silently substitute mock
data.

## 4. Shared value types

The TypeScript below is normative for field names and union discriminants.

```ts
type BotId = string;
type ConversationId = string;
type MessageId = string;
type ExecutionId = string;
type InteractionId = string;
type ParticipantId = string;
type AttachmentId = string;
type RoutineId = string;
type OpaqueCursor = string;

interface BotDescriptor {
  botId: BotId;
  revision: number;
  name: string;
  subtitle?: string;
  avatar?: BotAvatar;
  status: "available" | "unavailable" | "disabled";
  capabilities: string[];
}

type BotAvatar =
  | { type: "generated"; seed: string; palette?: string }
  | { type: "resource"; uri: string };

interface BotParticipantSnapshot {
  participantId: ParticipantId;
  kind: "human" | "bot";
  displayName: string;
  avatar?: BotAvatar;
}

interface BotConversationDescriptor {
  conversationId: ConversationId;
  revision: number;
  topology: "direct" | "group";
  title: string;
  participantIds: ParticipantId[];
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs?: number;
}

type BotMessageContentPart =
  | { type: "text"; text: string }
  | { type: "attachment"; attachment: BotAttachment }
  | { type: "resource"; uri: string; title: string };

interface BotMessage {
  messageId: MessageId;
  conversationId: ConversationId;
  clientMessageId?: string;
  author: BotParticipantSnapshot;
  createdAtMs: number;
  updatedAtMs: number;
  state: "streaming" | "complete" | "failed";
  content: BotMessageContentPart[];
  causalMessageId?: MessageId;
  executionId?: ExecutionId;
  error?: BotDomainErrorData;
}

interface BotExecution {
  executionId: ExecutionId;
  conversationId: ConversationId;
  participantId: ParticipantId;
  causalMessageId: MessageId;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAtMs?: number;
  completedAtMs?: number;
  error?: BotDomainErrorData;
}

interface BotPresenceFact {
  conversationId: ConversationId;
  participantId: ParticipantId;
  executionId: ExecutionId;
  phase: "queued" | "thinking" | "working" | "responding";
  activity?: string;
  observedAtMs: number;
  expiresAtMs: number;
}

interface BotAttachment {
  attachmentId: AttachmentId;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional Host-resolved display/download location. */
  downloadUri?: string;
}

interface BotEventStamp {
  epoch: string;
  seq: number;
}

interface BotLiveCursor {
  epoch: string;
  nextSeq: number;
}

interface BotDomainErrorData {
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

Participant snapshots are copied into messages. Renaming a Bot must not rewrite
historical message authorship.

## 5. Core request methods

The following methods are mandatory unless explicitly feature-gated.

### 5.1 `bot/list`

Lists Bots available on this Host.

```ts
params: {
  cursor?: OpaqueCursor;
  limit?: number;
}

result: {
  data: BotDescriptor[];
  nextCursor?: OpaqueCursor;
}
```

### 5.2 `bot/read`

```ts
params: { botId: BotId }
result: { bot: BotDescriptor }
```

### 5.3 `bot/conversation/list`

```ts
params: {
  cursor?: OpaqueCursor;
  limit?: number;
  archived?: boolean;
  botId?: BotId;
}

result: {
  data: BotConversationDescriptor[];
  nextCursor?: OpaqueCursor;
}
```

Ordering is newest `updatedAtMs` first, with `conversationId` as a stable
tie-breaker.

### 5.4 `bot/conversation/create`

```ts
params: {
  clientRequestId: string;
  topology: "direct" | "group";
  title?: string;
  participantIds: ParticipantId[];
}

result: {
  conversation: BotConversationDescriptor;
  replayed: boolean;
}
```

`clientRequestId` is an idempotency key. Repeating the same request returns the
same Conversation with `replayed: true`. Reusing it with different content is
`BOT_IDEMPOTENCY_CONFLICT`.

For a direct Conversation, `participantIds` contains exactly one Bot; the human
participant is implicit. Group creation requires `groupMembership`.

### 5.5 `bot/conversation/read`

This is the single hydration barrier for a Conversation view.

```ts
params: {
  conversationId: ConversationId;
  initialMessagesPage?: { limit: number };
}

result: {
  conversation: BotConversationDescriptor;
  participants: BotParticipantSnapshot[];
  initialMessagesPage: {
    data: BotMessage[];
    nextCursor?: OpaqueCursor;
  };
  executions: BotExecution[];
  interactions: BotInteraction[];
  presence: BotPresenceFact[];
  liveCursor: BotLiveCursor;
}
```

Messages are returned oldest-to-newest for immediate rendering. `nextCursor`
loads messages older than the first returned message.

There is deliberately no `bot/conversation/resume`. A Conversation is durable
state, not an execution. `read` hydrates state; active Executions are included
and continue through notifications.

### 5.6 `bot/conversation/update`

Requires `groupMembership` when modifying participants.

```ts
params: {
  conversationId: ConversationId;
  expectedRevision: number;
  patch: {
    title?: string;
    participantIds?: ParticipantId[];
  };
}

result: { conversation: BotConversationDescriptor }
```

`participantIds` is an atomic full replacement. V1 does not expose separate
add/remove commands. A stale revision fails with `BOT_REVISION_CONFLICT`.

### 5.7 `bot/conversation/archive`

```ts
params: { conversationId: ConversationId; expectedRevision: number }
result: { conversation: BotConversationDescriptor }
```

### 5.8 `bot/conversation/unarchive`

```ts
params: { conversationId: ConversationId; expectedRevision: number }
result: { conversation: BotConversationDescriptor }
```

### 5.9 `bot/conversation/delete`

```ts
params: { conversationId: ConversationId; expectedRevision: number }
result: { conversationId: ConversationId; revision: number }
```

An adapter may reject deletion of an engine-owned canonical direct
Conversation with `BOT_CAPABILITY_UNAVAILABLE`.

### 5.10 `bot/messages/list`

Loads an additional durable history page.

```ts
params: {
  conversationId: ConversationId;
  cursor?: OpaqueCursor;
  limit: number;
  direction: "backwards" | "forwards";
}

result: {
  data: BotMessage[];
  nextCursor?: OpaqueCursor;
}
```

`data` is always chronological, even for a backwards query. For ordinary
upward history loading, the client uses `direction: "backwards"` and prepends
the returned page without reordering existing Messages.

### 5.11 `bot/message/send`

```ts
type BotInputPart =
  | { type: "text"; text: string }
  | { type: "mention"; participantId: ParticipantId; label: string }
  | { type: "attachment"; attachmentId: AttachmentId }
  | { type: "resource"; uri: string; title: string };

params: {
  conversationId: ConversationId;
  clientMessageId: string;
  content: BotInputPart[];
  replyToMessageId?: MessageId;
}

result: {
  message: BotMessage;
  executions: BotExecution[];
  replayed: boolean;
}
```

`clientMessageId` is unique within the Conversation. Repeating the same content
returns the same receipt. Reusing the ID with different content fails with
`BOT_IDEMPOTENCY_CONFLICT`.

The returned human Message is authoritative and may immediately replace the
optimistic Message with the same `clientMessageId`. It must never create a
second visual row.

### 5.12 `bot/execution/cancel`

Requires `executionCancellation`.

```ts
params: {
  conversationId: ConversationId;
  executionId: ExecutionId;
  commandId: string;
}

result: {
  execution: BotExecution;
  replayed: boolean;
}
```

Cancellation always targets an explicit Execution. There is no ambiguous
“cancel latest” command. `commandId` makes retries idempotent.

### 5.13 `bot/interaction/respond`

Requires `interactions`.

```ts
type BotInteractionResponse =
  | { type: "approval"; choiceId: string }
  | { type: "clarification"; answers: Record<string, string | string[]> };

params: {
  conversationId: ConversationId;
  executionId: ExecutionId;
  interactionId: InteractionId;
  commandId: string;
  response: BotInteractionResponse;
}

result: {
  interaction: BotInteraction;
  replayed: boolean;
}
```

### 5.14 `bot/attachment/upload`

Requires `attachments`.

```ts
params: {
  clientAttachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  bytesBase64: string;
}

result: {
  attachment: BotAttachment;
  replayed: boolean;
}
```

V1 intentionally uses inline Base64 and enforces
`maxInlineAttachmentBytes`. Large multipart or signed uploads are a future
transport extension. Uploaded attachments not referenced by a sent Message may
be garbage-collected by the Host after its advertised retention period.

## 6. Interaction type

```ts
type BotInteraction =
  | {
      interactionId: InteractionId;
      conversationId: ConversationId;
      executionId: ExecutionId;
      participantId: ParticipantId;
      kind: "approval";
      status: "pending" | "resolved" | "expired";
      title: string;
      description?: string;
      choices: Array<{ choiceId: string; label: string; destructive?: boolean }>;
    }
  | {
      interactionId: InteractionId;
      conversationId: ConversationId;
      executionId: ExecutionId;
      participantId: ParticipantId;
      kind: "clarification";
      status: "pending" | "resolved" | "expired";
      title: string;
      questions: Array<{
        questionId: string;
        prompt: string;
        multiple?: boolean;
        choices?: Array<{ value: string; label: string }>;
      }>;
    };
```

Pending interactions are durable enough to be returned by
`bot/conversation/read`; they are not modeled only as transient JSON-RPC
server requests.

## 7. Server notifications

### 7.1 Conversation-scoped ordering

Every Conversation-scoped notification contains:

```ts
interface ConversationEventEnvelope {
  stamp: BotEventStamp;
  conversationId: ConversationId;
}
```

`epoch` identifies one server journal generation. `seq` is monotonically
increasing within `(Host, Conversation, epoch)`.

The mandatory notification words are:

| Method | Meaning |
| --- | --- |
| `bot/conversation/updated` | Conversation metadata or membership changed |
| `bot/conversation/deleted` | Conversation was deleted |
| `bot/message/started` | A streaming assistant Message shell now exists |
| `bot/message/delta` | Append streaming content to an existing Message |
| `bot/message/completed` | Full authoritative final/failed Message snapshot |
| `bot/execution/updated` | Execution lifecycle changed |
| `bot/presence/updated` | Replace or clear one participant’s live Presence |
| `bot/interaction/requested` | Durable interaction is waiting for a response |
| `bot/interaction/resolved` | Interaction resolved or expired |

Global Bot notifications are:

| Method | Meaning |
| --- | --- |
| `bot/updated` | Bot descriptor changed |
| `bot/deleted` | Bot was deleted or revoked |

### 7.2 `bot/message/started`

```ts
params: {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  message: BotMessage; // state === "streaming"
}
```

### 7.3 `bot/message/delta`

```ts
params: {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  messageId: MessageId;
  executionId: ExecutionId;
  deltaSeq: number;
  partIndex: number;
  delta: string;
}
```

`deltaSeq` starts at 0 per Message and increments by one. Duplicate deltas are
ignored. A gap causes a Conversation re-read; the client must not guess missing
text.

### 7.4 `bot/message/completed`

```ts
params: {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  message: BotMessage; // state === "complete" | "failed"
}
```

The full snapshot replaces the streaming projection under the same
`messageId`; it must not append a new row or change layout identity.

### 7.5 `bot/execution/updated`

```ts
params: {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  execution: BotExecution;
}
```

### 7.6 `bot/presence/updated`

```ts
params: {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  participantId: ParticipantId;
  executionId: ExecutionId;
  presence: BotPresenceFact | null;
}
```

Presence is replace-by-key state keyed by
`(participantId, executionId)`. `null` clears it. The Renderer must also expire
it locally at `expiresAtMs`; expired Presence never becomes Message history.

### 7.7 Other notification shapes

```ts
"bot/conversation/updated": {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  conversation: BotConversationDescriptor;
}

"bot/conversation/deleted": {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  revision: number;
}

"bot/interaction/requested": {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  interaction: BotInteraction;
}

"bot/interaction/resolved": {
  stamp: BotEventStamp;
  conversationId: ConversationId;
  interaction: BotInteraction;
}

"bot/updated": { bot: BotDescriptor }

"bot/deleted": { botId: BotId; revision: number }
```

## 8. Hydration and live-event barrier

The client must use this exact state machine:

1. Register the connection’s Bot notification listener.
2. Begin buffering notifications for the target Conversation.
3. Call `bot/conversation/read`.
4. Atomically install the returned snapshot.
5. Read `liveCursor = {epoch, nextSeq}`.
6. Discard buffered events from another epoch or with `seq < nextSeq`.
7. Apply buffered events starting exactly at `nextSeq` in sequence order.
8. If the first applicable event is greater than `nextSeq`, or any later gap is
   found, discard the projection and repeat `bot/conversation/read`.
9. Switch from buffer mode to live mode without replacing the Message list.

This is the invariant that prevents the current “history paints once, then
refreshes/reflows seconds later” class of bugs. V1 does not require the server
to expose a public event-journal replay method; a gap is recovered with a fresh
snapshot. A future Replica extension may add replay without changing Bot
entities.

## 9. Optional Bot management methods

These methods require `features.botManagement`:

```ts
"bot/create": {
  params: { clientRequestId: string; name: string; templateId?: string };
  result: { bot: BotDescriptor; replayed: boolean };
}

"bot/update": {
  params: {
    botId: BotId;
    expectedRevision: number;
    patch: { name?: string; subtitle?: string; status?: "available" | "disabled" };
  };
  result: { bot: BotDescriptor };
}

"bot/delete": {
  params: { botId: BotId; expectedRevision: number };
  result: { botId: BotId; revision: number };
}
```

## 10. Optional Bot asset methods

These methods require `features.botAssets`:

```ts
"bot/asset/read": {
  params: { botId: BotId; slot: "avatar" | "background" };
  result: { mimeType: string; bytesBase64: string; revision: number };
}

"bot/asset/write": {
  params: {
    botId: BotId;
    slot: "avatar" | "background";
    mimeType: string;
    bytesBase64: string;
    expectedRevision?: number;
  };
  result: { bot: BotDescriptor; revision: number };
}
```

Animation state is not a Bot asset and never crosses this protocol. The view
derives animation from Presence and Execution state.

## 11. Optional configuration methods

These methods require `features.configuration`:

```ts
type BotConfigValue = string | number | boolean | string[] | null;

interface BotConfigField {
  key: string;
  label: string;
  kind: "string" | "number" | "boolean" | "select" | "multi-select" | "secret";
  value: BotConfigValue;
  options?: Array<{ value: string; label: string }>;
  mutable: boolean;
}

"bot/config/read": {
  params: { botId: BotId };
  result: { botId: BotId; revision: number; fields: BotConfigField[] };
}

"bot/config/options": {
  params: { botId: BotId; key: string; cursor?: OpaqueCursor; limit?: number };
  result: {
    data: Array<{ value: string; label: string }>;
    nextCursor?: OpaqueCursor;
  };
}

"bot/config/update": {
  params: {
    botId: BotId;
    expectedRevision: number;
    changes: Record<string, BotConfigValue>;
  };
  result: { botId: BotId; revision: number; fields: BotConfigField[] };
}
```

This single typed surface covers model selection, MCP enablement, skills, and
other engine-supported settings without exposing engine command names.

## 12. Optional routine methods

These methods require `features.routines`:

```ts
interface BotRoutine {
  routineId: RoutineId;
  revision: number;
  botId: BotId;
  conversationId?: ConversationId;
  title: string;
  prompt: string;
  schedule: { type: "cron"; expression: string; timezone: string };
  enabled: boolean;
}

"bot/routine/list": {
  params: { botId?: BotId; cursor?: OpaqueCursor; limit?: number };
  result: { data: BotRoutine[]; nextCursor?: OpaqueCursor };
}

"bot/routine/create": {
  params: {
    clientRequestId: string;
    botId: BotId;
    conversationId?: ConversationId;
    title: string;
    prompt: string;
    schedule: BotRoutine["schedule"];
    enabled: boolean;
  };
  result: { routine: BotRoutine; replayed: boolean };
}

"bot/routine/update": {
  params: {
    routineId: RoutineId;
    expectedRevision: number;
    patch: Partial<Pick<BotRoutine, "title" | "prompt" | "schedule" | "enabled">>;
  };
  result: { routine: BotRoutine };
}

"bot/routine/delete": {
  params: { routineId: RoutineId; expectedRevision: number };
  result: { routineId: RoutineId; revision: number };
}

"bot/routine/run": {
  params: { routineId: RoutineId; commandId: string };
  result: { execution: BotExecution; replayed: boolean };
}
```

Routine notifications are `bot/routine/updated` with `{routine}` and
`bot/routine/deleted` with `{routineId, revision}`.

## 13. Error codes

Standard JSON-RPC errors remain unchanged:

| JSON-RPC code | Meaning |
| --- | --- |
| `-32700` | Parse error |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |

Bot domain errors use:

| Code | `error.data.code` | Retryable by default |
| --- | --- | --- |
| `-32040` | `BOT_NOT_FOUND` | No |
| `-32041` | `BOT_CONVERSATION_NOT_FOUND` | No |
| `-32042` | `BOT_REVISION_CONFLICT` | No; re-read first |
| `-32043` | `BOT_IDEMPOTENCY_CONFLICT` | No |
| `-32044` | `BOT_EXECUTION_NOT_FOUND` | No |
| `-32045` | `BOT_INTERACTION_NOT_FOUND` | No |
| `-32046` | `BOT_INVALID_STATE` | No |
| `-32047` | `BOT_CAPABILITY_UNAVAILABLE` | No |
| `-32048` | `BOT_LIMIT_EXCEEDED` | No |
| `-32049` | `BOT_BACKEND_UNAVAILABLE` | Yes |
| `-32050` | `BOT_ATTACHMENT_NOT_FOUND` | No |

Every domain error must include:

```ts
{
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

## 14. Complete direct-message wire example

### 14.1 Send

```json
{
  "jsonrpc": "2.0",
  "id": "send-7",
  "method": "bot/message/send",
  "params": {
    "conversationId": "conversation-12",
    "clientMessageId": "client-message-93",
    "content": [{ "type": "text", "text": "检查发布状态" }]
  }
}
```

### 14.2 Receipt

```json
{
  "jsonrpc": "2.0",
  "id": "send-7",
  "result": {
    "message": {
      "messageId": "message-901",
      "conversationId": "conversation-12",
      "clientMessageId": "client-message-93",
      "author": {
        "participantId": "human-me",
        "kind": "human",
        "displayName": "You"
      },
      "createdAtMs": 1788570000000,
      "updatedAtMs": 1788570000000,
      "state": "complete",
      "content": [{ "type": "text", "text": "检查发布状态" }]
    },
    "executions": [{
      "executionId": "execution-55",
      "conversationId": "conversation-12",
      "participantId": "bot-hermes",
      "causalMessageId": "message-901",
      "status": "queued"
    }],
    "replayed": false
  }
}
```

### 14.3 Execution starts

```json
{
  "jsonrpc": "2.0",
  "method": "bot/execution/updated",
  "params": {
    "stamp": { "epoch": "epoch-a", "seq": 81 },
    "conversationId": "conversation-12",
    "execution": {
      "executionId": "execution-55",
      "conversationId": "conversation-12",
      "participantId": "bot-hermes",
      "causalMessageId": "message-901",
      "status": "running",
      "startedAtMs": 1788570000120
    }
  }
}
```

### 14.4 Presence changes

```json
{
  "jsonrpc": "2.0",
  "method": "bot/presence/updated",
  "params": {
    "stamp": { "epoch": "epoch-a", "seq": 82 },
    "conversationId": "conversation-12",
    "participantId": "bot-hermes",
    "executionId": "execution-55",
    "presence": {
      "conversationId": "conversation-12",
      "participantId": "bot-hermes",
      "executionId": "execution-55",
      "phase": "working",
      "activity": "Checking deployment",
      "observedAtMs": 1788570000150,
      "expiresAtMs": 1788570015150
    }
  }
}
```

### 14.5 Stream starts and advances

```json
{
  "jsonrpc": "2.0",
  "method": "bot/message/started",
  "params": {
    "stamp": { "epoch": "epoch-a", "seq": 83 },
    "conversationId": "conversation-12",
    "message": {
      "messageId": "message-902",
      "conversationId": "conversation-12",
      "author": {
        "participantId": "bot-hermes",
        "kind": "bot",
        "displayName": "Hermes"
      },
      "createdAtMs": 1788570000200,
      "updatedAtMs": 1788570000200,
      "state": "streaming",
      "content": [{ "type": "text", "text": "" }],
      "causalMessageId": "message-901",
      "executionId": "execution-55"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "bot/message/delta",
  "params": {
    "stamp": { "epoch": "epoch-a", "seq": 84 },
    "conversationId": "conversation-12",
    "messageId": "message-902",
    "executionId": "execution-55",
    "deltaSeq": 0,
    "partIndex": 0,
    "delta": "发布状态正常。"
  }
}
```

### 14.6 Completion

```json
{
  "jsonrpc": "2.0",
  "method": "bot/message/completed",
  "params": {
    "stamp": { "epoch": "epoch-a", "seq": 85 },
    "conversationId": "conversation-12",
    "message": {
      "messageId": "message-902",
      "conversationId": "conversation-12",
      "author": {
        "participantId": "bot-hermes",
        "kind": "bot",
        "displayName": "Hermes"
      },
      "createdAtMs": 1788570000200,
      "updatedAtMs": 1788570000800,
      "state": "complete",
      "content": [{ "type": "text", "text": "发布状态正常。" }],
      "causalMessageId": "message-901",
      "executionId": "execution-55"
    }
  }
}
```

The Host then emits `bot/execution/updated` with `status: "completed"` and
`bot/presence/updated` with `presence: null`. The UI keeps one Message row from
`started` through `completed`; only its content and state change.

## 15. Hermes Desktop adapter mapping

The LightVela Hermes adapter implements the OpenCraft methods as follows:

| OpenCraft protocol | Hermes capability |
| --- | --- |
| `bot/list`, `bot/read` | `profiles.list`, `profiles.describe` |
| `bot/create`, `bot/update`, `bot/delete` | `profiles.create`, `profiles.configure`, profile deletion when supported |
| `bot/asset/read`, `bot/asset/write` | `profiles.get_asset`, `profiles.set_asset` |
| `bot/conversation/list` | `session.list` plus group repository records |
| `bot/conversation/create` | `session.create`; for groups create one hidden Session per Bot member |
| `bot/conversation/read` | REST/session history plus `session.resume`, reconciled behind one hydration barrier |
| `bot/conversation/update` | `session.title`; group membership is handled by the group coordinator |
| `bot/messages/list` | Hermes history page/cursor adapter |
| `bot/attachment/upload` | `image.attach_bytes`, `pdf.attach`, or `file.attach` |
| `bot/message/send` | attachment handles followed by `prompt.submit` |
| `bot/execution/cancel` | `session.interrupt` for the mapped execution/session |
| `bot/interaction/respond` | `approval.respond` or `clarify.respond` |
| `bot/config/*` | `profiles.describe/configure`, `model.options`, `mcp.catalog`, `skills.manage` |
| `bot/routine/*` | `cron.manage` |

Hermes private details must remain behind the adapter:

- TAT/WebSocket tickets and Tencent instance identifiers
- Hermes runtime Session IDs and hidden group Session titles
- `profile.ui_meta`
- group watermarks, epochs, and relay bookkeeping
- `bot_relay.*` calls

Hermes Desktop itself does not provide an authoritative Bot-group abstraction.
For direct chat, Hermes Session history remains authoritative and the adapter
does not need a second message database. For group chat, the
`BotConversationService` backend owns the room log, membership, orchestration,
and hidden member-session mapping. While the backend temporarily runs in the
browser, IndexedDB may implement that authority, but it is explicitly a
single-browser implementation and not cross-device truth.

## 16. Cordis service contract

The Cordis service mirrors domain operations, not JSON strings:

```ts
interface BotConversationService {
  listBots(input: ListBotsInput): Promise<Page<BotDescriptor>>;
  readBot(botId: BotId): Promise<BotDescriptor>;

  listConversations(input: ListConversationsInput): Promise<Page<BotConversationDescriptor>>;
  createConversation(input: CreateConversationInput): Promise<CreateConversationReceipt>;
  readConversation(input: ReadConversationInput): Promise<BotConversationHydration>;
  updateConversation(input: UpdateConversationInput): Promise<BotConversationDescriptor>;
  archiveConversation(input: RevisionCommand): Promise<BotConversationDescriptor>;
  unarchiveConversation(input: RevisionCommand): Promise<BotConversationDescriptor>;
  deleteConversation(input: RevisionCommand): Promise<void>;

  listMessages(input: ListMessagesInput): Promise<Page<BotMessage>>;
  sendMessage(input: SendBotMessageInput): Promise<SendBotMessageReceipt>;
  cancelExecution(input: CancelBotExecutionInput): Promise<BotExecution>;
  respondToInteraction(input: RespondToBotInteractionInput): Promise<BotInteraction>;
  uploadAttachment(input: UploadBotAttachmentInput): Promise<BotAttachment>;

  subscribe(listener: (event: BotConversationEvent) => void): () => void;
}
```

`AppServerBotConversationClient` is one provider of this service. A local
in-process provider is allowed only if it enters through the same request
handler and codec; UI code must not detect which deployment form is active.

## 17. Acceptance invariants

An implementation is not V1-compliant until all of these pass:

1. Repeating `bot/message/send` with the same `clientMessageId` and payload
   produces one Message; a different payload produces an idempotency conflict.
2. An optimistic human Message and its receipt reconcile to one stable row.
3. `message/started`, all deltas, and `message/completed` retain one stable
   `messageId` and therefore one layout identity.
4. Duplicate `deltaSeq` is ignored; a gap triggers re-hydration.
5. Notifications received during `bot/conversation/read` are buffered and
   applied after its `liveCursor` without a second visible history tree.
6. A changed `epoch` triggers re-hydration.
7. Loading older messages prepends without changing the identity or measured
   geometry of existing messages.
8. Cancelling targets the requested `executionId`, including when several Bots
   execute concurrently.
9. Pending approvals and clarifications survive a page refresh through
   `bot/conversation/read`.
10. Stale Conversation revisions cannot overwrite newer membership.
11. Presence expiry removes activity animation without creating a Message.
12. The public protocol contains no `Turn`, Hermes Session, TAT, Electron,
    IndexedDB, React, or transport-provider types.

## 18. Deliberately deferred from V1

- Public journal replay (`bot/events/since`); V1 rehydrates on a sequence gap.
- Cross-Host group Conversations.
- Large multipart and signed attachment upload.
- End-to-end encrypted rooms.
- Federation and server-to-server Bot relay.
- Durable multi-device group authority while the temporary handler runs solely
  in a browser.

These can be added as negotiated extensions without changing the V1 command
words or entity identities.
