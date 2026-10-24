# Bot Conversations V1: Optional methods

[Protocol index](../../appserver-bot-protocol-v1.md) · [Documentation index](../../README.md)

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
