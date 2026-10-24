type Value = Record<string, unknown>;
function object(value: unknown): Value { return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export type MessageFieldProjector = (threadId: string, clientId: string, value: Value) => Value;

function projectItem(project: MessageFieldProjector, threadId: string, value: unknown): unknown {
  const item = object(value);
  if (item.type !== "userMessage" && item.type !== "UserMessage" && item.type !== "steeringUserMessage") return value;
  const clientId = string(item.clientId) || string(item.client_id) || string(item.clientUserMessageId);
  if (!threadId) return value;
  return project(threadId, clientId, item);
}

function projectTurn(project: MessageFieldProjector, threadId: string, value: unknown): unknown {
  const turn = object(value);
  const params = object(turn.params);
  const clientId = string(params.clientUserMessageId) || string(params.clientId);
  const projectedParams = threadId && clientId ? project(threadId, clientId, params) : params;
  return {
    ...turn,
    ...(Object.keys(params).length > 0 ? { params: projectedParams } : {}),
    ...(Array.isArray(turn.items) ? { items: turn.items.map(item => projectItem(project, threadId, item)) } : {}),
  };
}

/** Enrich only the common AppServer history containers; leave unknown RPC payloads intact. */
export function projectThreadMessageResult(
  project: MessageFieldProjector,
  method: string,
  requestParams: Value,
  resultValue: unknown,
): unknown {
  const result = object(resultValue);
  const thread = object(result.thread);
  const threadId = string(thread.id) || string(requestParams.threadId);
  if (!threadId) return resultValue;
  return {
    ...result,
    ...(result.thread && typeof result.thread === "object" ? {
      thread: {
        ...thread,
        ...(Array.isArray(thread.turns)
          ? { turns: thread.turns.map(turn => projectTurn(project, threadId, turn)) }
          : {}),
      },
    } : {}),
    ...(result.turn && typeof result.turn === "object"
      ? { turn: projectTurn(project, threadId, result.turn) }
      : {}),
    ...(Array.isArray(result.turns)
      ? { turns: result.turns.map(turn => projectTurn(project, threadId, turn)) }
      : {}),
    ...(Array.isArray(result.items)
      ? { items: result.items.map(item => projectItem(project, threadId, item)) }
      : {}),
    ...(method === "thread/turns/list" && Array.isArray(result.data)
      ? { data: result.data.map(turn => projectTurn(project, threadId, turn)) }
      : {}),
    ...(method === "thread/items/list" && Array.isArray(result.data)
      ? { data: result.data.map(entry => {
        const value = object(entry);
        return { ...value, item: projectItem(project, threadId, value.item) };
      }) }
      : {}),
  };
}

export function projectThreadMessageNotification(
  project: MessageFieldProjector,
  message: Value,
): Value {
  const params = object(message.params);
  const threadId = string(params.threadId);
  if (!threadId) return message;
  if (params.item && typeof params.item === "object") {
    return { ...message, params: { ...params, item: projectItem(project, threadId, params.item) } };
  }
  if (params.turn && typeof params.turn === "object") {
    return { ...message, params: { ...params, turn: projectTurn(project, threadId, params.turn) } };
  }
  return message;
}
