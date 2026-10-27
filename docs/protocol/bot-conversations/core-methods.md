# Bot Conversations V1: Core methods

[Protocol index](../../appserver-bot-protocol-v1.md) · [Documentation index](../../README.md)

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
