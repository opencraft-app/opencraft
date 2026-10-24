import type { TimelineSourceItem, TimelineSourceTurn } from "./projection";

type RecordValue = Readonly<Record<string, unknown>>;

interface UserMessageCompareKey {
  readonly rawText: string;
  readonly imageCount: number;
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}

/** Normalize only our saved projection keys; external payload fields stay opaque. */
function projectionPayload(data: RecordValue): RecordValue {
  const result: Record<string, unknown> = { ...data };
  for (const suffix of ["MessageKind", "SourceItemIds", "SourceItemId", "TurnParamsMessage", "SteeringStatus"]) {
    const canonical = `__opencraft${suffix}`;
    const legacy = `__vela${suffix}`;
    if (result[canonical] == null && Object.hasOwn(result, legacy)) result[canonical] = result[legacy];
    delete result[legacy];
  }
  return result;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentParts(value: unknown): readonly unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

export function userMessageCompareKey(value: unknown): UserMessageCompareKey {
  if (typeof value === "string") return { rawText: value, imageCount: 0 };
  const text: string[] = [];
  let imageCount = 0;
  for (const part of contentParts(value)) {
    const data = record(part);
    if (typeof part === "string") text.push(part);
    else if (data.type === "text" && typeof data.text === "string") text.push(data.text);
    if (data.type === "image" || data.type === "localImage") imageCount++;
  }
  return { rawText: text.join("\n"), imageCount };
}

function inputOf(item: TimelineSourceItem): unknown {
  const data = record(item.payload);
  return item.type === "steeringUserMessage" ? data.input ?? data.content : data.content ?? data.input;
}

function clientOf(data: RecordValue): string | null {
  return string(data.clientId) ?? string(data.clientUserMessageId);
}

function equalInput(left: unknown, right: unknown): boolean {
  const a = userMessageCompareKey(left);
  const b = userMessageCompareKey(right);
  return a.rawText === b.rawText && a.imageCount === b.imageCount;
}

function identities(item: TimelineSourceItem, server?: TimelineSourceItem): string[] {
  const data = record(item.payload);
  const old = data.__opencraftSourceItemIds ?? data.__velaSourceItemIds;
  return [...new Set([item.id, ...(Array.isArray(old) ? old.filter((id): id is string => typeof id === "string") : []),
    ...(server ? [server.id] : [])])];
}

function hasStagedDisplay(input: unknown): boolean {
  const parts = contentParts(input);
  const mentions = parts.map(record).filter(part => part.type === "mention" && typeof part.name === "string" && typeof part.path === "string");
  for (const part of parts) {
    const data = record(part);
    const elements = data.text_elements ?? data.textElements;
    if (data.type !== "text" || typeof data.text !== "string" || !Array.isArray(elements)) continue;
    const text = data.text;
    const length = new TextEncoder().encode(text).length;
    for (const element of elements) {
      const span = record(element);
      const range = record(span.byteRange ?? span.byte_range);
      if (range.start !== 0 || range.end !== length) continue;
      if (span.placeholder === "opencraft:staged-file:v1") return true;
      if (span.placeholder === "" && mentions.some(mention => text ===
        `The user attached a file named ${JSON.stringify(mention.name)}. Its readable path on this Host is ${JSON.stringify(mention.path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`)) return true;
    }
  }
  return false;
}

function localCanReceive(item: TimelineSourceItem): boolean {
  if (item.type !== "steeringUserMessage") return false;
  const status = record(item.payload).status;
  return status == null || status === "pending" || status === "accepted";
}

/** Associate echoes only with earlier local rows; the last echo owns metadata. */
function steeringAcknowledgements(items: readonly TimelineSourceItem[]) {
  const latest = new Map<number, TimelineSourceItem>();
  const consumed = new Set<number>();
  const eligible: number[] = [];
  for (let serverIndex = 0; serverIndex < items.length; serverIndex++) {
    const server = items[serverIndex]!;
    if (localCanReceive(server)) eligible.push(serverIndex);
    if (server.type !== "userMessage") continue;
    const client = clientOf(record(server.payload));
    for (const localIndex of eligible) {
      const local = items[localIndex]!;
      const localData = record(local.payload);
      const localClient = clientOf(localData);
      if (string(localData.serverUserMessageId) === server.id || (client !== null && client === localClient) || equalInput(inputOf(local), inputOf(server))) {
        latest.set(localIndex, server);
        consumed.add(serverIndex);
        break;
      }
    }
  }
  return { latest, consumed };
}

/** Setup events can precede the initial echo without taking message ownership. */
const initialEchoPrefix = new Set([
  "automaticApprovalReview", "contextCompaction", "forkedFromConversation", "modelChanged",
  "modelRerouted", "personalityChanged", "remoteTaskCreated", "worktreeInit",
]);

function initialEcho(turn: TimelineSourceTurn, params: RecordValue): TimelineSourceItem | undefined {
  const client = string(params.clientUserMessageId) ?? string(params.clientId);
  for (const item of turn.items) {
    if (initialEchoPrefix.has(item.type)) continue;
    if (item.type === "userMessage" && (
      (client !== null && client === clientOf(record(item.payload))) || equalInput(params.input, inputOf(item))
    )) return item;
    break;
  }
  return undefined;
}

function canonicalMessage(turn: TimelineSourceTurn, params: RecordValue, server?: TimelineSourceItem): TimelineSourceItem {
  const id = server?.id ?? `${turn.id}:composer-user-message`;
  const data = record(server?.payload);
  const content = server && hasStagedDisplay(inputOf(server)) ? inputOf(server) : params.input;
  return {
    id, type: "userMessage", payload: {
      ...projectionPayload(data), id, type: "userMessage", content,
      clientId: string(params.clientUserMessageId) ?? string(params.clientId) ?? clientOf(data),
      attachments: params.attachments ?? data.attachments,
      sender: data.sender ?? params.sender ?? null,
      commentAttachments: params.commentAttachments ?? data.commentAttachments,
      mcpAppModelContextAttachments: turn.mcpAppModelContextAttachments,
      __opencraftMessageKind: "user",
      __opencraftSourceItemIds: server ? identities(server) : [id],
      __opencraftTurnParamsMessage: true,
    },
  };
}

function localMessage(item: TimelineSourceItem, server?: TimelineSourceItem): TimelineSourceItem {
  const data = record(item.payload);
  const acknowledged = record(server?.payload);
  return { ...item, payload: {
    ...projectionPayload(data),
    input: server && hasStagedDisplay(inputOf(server)) ? inputOf(server) : inputOf(item),
    attachments: data.attachments ?? acknowledged.attachments,
    sender: acknowledged.sender ?? data.sender ?? null,
    __opencraftMessageKind: "steering", __opencraftSourceItemIds: identities(item, server),
    serverUserMessageId: server?.id ?? string(data.serverUserMessageId),
  } };
}

export function normalizeTurnUserMessages(turn: TimelineSourceTurn): TimelineSourceTurn {
  const params = record(turn.params);
  const canonical = params.input != null && !(Array.isArray(params.input) && params.input.length === 0);
  const client = string(params.clientUserMessageId) ?? string(params.clientId);
  const echo = canonical ? initialEcho(turn, params) : undefined;
  const { latest, consumed } = steeringAcknowledgements(turn.items);
  const items: TimelineSourceItem[] = [];
  const hidden = new Set(turn.nonVisualItemIds ?? []);
  let leading = !canonical && turn.preserveServerUserMessages !== true;
  if (canonical) items.push(canonicalMessage(turn, params, echo));
  for (let index = 0; index < turn.items.length; index++) {
    const item = turn.items[index]!;
    if (item === echo || consumed.has(index)) continue;
    if (item.type === "steeringUserMessage") {
      items.push(localMessage(item, latest.get(index)));
      continue;
    }
    if (item.type === "steered") {
      hidden.add(item.id);
      leading = false;
      continue;
    }
    if (item.type !== "userMessage") {
      items.push(item);
      if (item.type !== "hookPrompt" && item.type !== "worktreeInit") leading = false;
      continue;
    }
    const data = record(item.payload);
    const serverClient = clientOf(data);
    if (leading) items.push({ ...item, payload: { ...projectionPayload(data), __opencraftMessageKind: "user" } });
    else if (turn.preserveServerUserMessages === true || (serverClient !== null && !(client !== null && client === serverClient))) {
      items.push({ ...item, payload: { ...projectionPayload(data), __opencraftMessageKind: "steering", __opencraftSteeringStatus: "accepted" } });
    } else hidden.add(item.id);
  }
  return { ...turn, items, ...(turn.nonVisualItemIds !== undefined || hidden.size > 0 ? { nonVisualItemIds: [...hidden] } : {}) };
}
