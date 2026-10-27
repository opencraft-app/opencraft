# Bot Conversations V1: Ownership and wire

[Protocol index](../../appserver-bot-protocol-v1.md) · [Documentation index](../../README.md)


Status: **implementation baseline**\
Wire protocol: **JSON-RPC 2.0 over WebSocket**\
Extension identifier: **`opencraft/bot-conversations`**
Version: **1**

This document freezes the first implementable Bot and group-chat protocol for
OpenCraft. It is intentionally engine-neutral. An engine-specific adapter sits
behind an AppServer handler; none of its private types appear on the wire.
A Host advertises the extension only after its Bot handler is connected. Native
Codex uses Thread/Turn and does not currently advertise this Bot extension.

## 1. Ownership boundaries

The ownership chain is:

```text
BotChatView
  -> Cordis BotConversationService
  -> AppServerBotConversationClient
  -> bot/* JSON-RPC methods
  -> AppServer BotConversationHandler
  -> connected Bot-capable engine adapter
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
   Hermes, enterprise service, Electron, IndexedDB, or React types.
4. A WebSocket connection is already scoped to one Host. Bot payloads must not
   repeat `hostId`; the outer `HostRuntimeRegistry` owns Host routing.
5. Conversations, Messages, and Executions are separate durable entities.
   Presence is an expiring observation.
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
        "opencraft/bot-conversations": { "version": 1 }
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
        "opencraft/bot-conversations": {
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
