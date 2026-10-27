# Bot Conversations V1: Direct-message example

[Protocol index](../../appserver-bot-protocol-v1.md) · [Documentation index](../../README.md)

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
