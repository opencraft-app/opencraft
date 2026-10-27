# Bot Conversations V1: Notifications and hydration

[Protocol index](../../appserver-bot-protocol-v1.md) · [Documentation index](../../README.md)

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
