import type { AttachmentRef } from "@opencraft/appserver-protocol";

type Value = Record<string, unknown>;

function object(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
}

function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export interface MessageAttachmentReader {
  list(threadId: string, clientMessageId: string): readonly AttachmentRef[];
}

function displayAttachments(refs: readonly AttachmentRef[]): Value[] {
  return refs.map(ref => ({
    id: ref.id,
    name: ref.name,
    mimeType: ref.mimeType,
    size: ref.size,
    ...(ref.location.kind === "host-file" ? { path: ref.location.path } : { url: ref.location.url }),
  }));
}

function withAttachments(value: Value, refs: readonly AttachmentRef[]): Value {
  if (refs.length === 0) return value;
  const existing = Array.isArray(value.attachments) ? value.attachments : [];
  const identities = new Set(existing.map(entry => string(object(entry).id)));
  return {
    ...value,
    attachments: [...existing, ...displayAttachments(refs).filter(entry => !identities.has(string(entry.id)))],
  };
}

function projectItem(reader: MessageAttachmentReader, threadId: string, value: unknown): unknown {
  const item = object(value);
  if (item.type !== "userMessage" && item.type !== "UserMessage") return value;
  const clientId = string(item.clientId) || string(item.client_id) || string(item.clientUserMessageId);
  if (!threadId || !clientId) return value;
  return withAttachments(item, reader.list(threadId, clientId));
}

function projectTurn(reader: MessageAttachmentReader, threadId: string, value: unknown): unknown {
  const turn = object(value);
  const params = object(turn.params);
  const clientId = string(params.clientUserMessageId) || string(params.clientId);
  const refs = threadId && clientId ? reader.list(threadId, clientId) : [];
  return {
    ...turn,
    ...(Object.keys(params).length > 0 && refs.length > 0 ? { params: withAttachments(params, refs) } : {}),
    ...(Array.isArray(turn.items) ? { items: turn.items.map(item => projectItem(reader, threadId, item)) } : {}),
  };
}

/** Enrich only known Codex history containers; leave unknown RPC payloads intact. */
export function projectCodexAttachmentResult(
  reader: MessageAttachmentReader,
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
          ? { turns: thread.turns.map(turn => projectTurn(reader, threadId, turn)) }
          : {}),
      },
    } : {}),
    ...(result.turn && typeof result.turn === "object"
      ? { turn: projectTurn(reader, threadId, result.turn) }
      : {}),
    ...(Array.isArray(result.turns)
      ? { turns: result.turns.map(turn => projectTurn(reader, threadId, turn)) }
      : {}),
    ...(Array.isArray(result.items)
      ? { items: result.items.map(item => projectItem(reader, threadId, item)) }
      : {}),
    ...(method === "thread/turns/list" && Array.isArray(result.data)
      ? { data: result.data.map(turn => projectTurn(reader, threadId, turn)) }
      : {}),
    ...(method === "thread/items/list" && Array.isArray(result.data)
      ? { data: result.data.map(entry => {
        const value = object(entry);
        return { ...value, item: projectItem(reader, threadId, value.item) };
      }) }
      : {}),
  };
}

export function projectCodexAttachmentNotification(
  reader: MessageAttachmentReader,
  message: Value,
): Value {
  const params = object(message.params);
  const threadId = string(params.threadId);
  if (!threadId) return message;
  if (params.item && typeof params.item === "object") {
    return { ...message, params: { ...params, item: projectItem(reader, threadId, params.item) } };
  }
  if (params.turn && typeof params.turn === "object") {
    return { ...message, params: { ...params, turn: projectTurn(reader, threadId, params.turn) } };
  }
  return message;
}
