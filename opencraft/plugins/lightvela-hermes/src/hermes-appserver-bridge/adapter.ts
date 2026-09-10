import { HermesRpcError, type HermesRpcClient } from "./rpc-transport";
import type { HermesHistoryClient } from "./history-client";
import {
  decodeHermesModelSelection,
  hermesModelSwitchArgument,
  mapHermesModelOptions,
  modelSelectionFromExecution,
} from "./model-catalog";
import type {
  AppServerThread,
  AppServerTurn,
  HermesMessage,
  HermesModelOptionsPayload,
  HermesPendingClarify,
  HermesProfileSummary,
  HermesSessionPayload,
  HermesSessionSummary,
  QueuedSubmission,
} from "./types";
import { HermesTurnEventStateMachine } from "./turn-event-state-machine";
import { toolOutcome } from "./tool-outcome";
import { projectHermesTool } from "./tool-semantics";
import { HermesTranscriptWindow, type HermesTranscriptWindowSnapshot } from "./transcript-window";
import { appendLiveSessionProjection } from "./live-session-projection";
import type { HermesProjectionRecovery } from "./projection-recovery";
import {
  MemoryHermesComposerQueueService,
  type HermesComposerQueueService,
} from "./composer-queue/service";
import { throwIfSignalAborted } from "@opencraft/workbench-runtime";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

class HermesAppServerDomainError extends Error {
  readonly rpcCode = -32009;

  constructor(
    message: string,
    readonly domainData: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HermesAppServerDomainError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

type HermesImageInput =
  | { kind: "bytes"; contentBase64: string; filename: string }
  | { kind: "path"; path: string };

interface ParsedInput {
  body: string;
  content: Record<string, unknown>[];
  images: HermesImageInput[];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") return [(part as { text: string }).text];
    return [];
  }).join("\n");
}

function messageText(message: HermesMessage): string {
  if (message.display_content !== undefined) return text(message.display_content);
  return typeof message.text === "string" ? message.text : text(message.content);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/bmp": return "bmp";
    default: return "png";
  }
}

function filenameForUrl(url: string, mimeType: string, index: number): string {
  try {
    const candidate = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (candidate !== undefined && /\.[a-z0-9]{2,5}$/iu.test(candidate)) return candidate;
  } catch {
    // Data URLs and malformed path hints use the deterministic fallback below.
  }
  return `image-${index + 1}.${imageExtension(mimeType)}`;
}

function parseDataImage(url: string, index: number): HermesImageInput | null {
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/isu.exec(url);
  if (match === null) return null;
  const contentBase64 = match[2]!.replace(/\s/gu, "");
  if (contentBase64.length === 0) throw new Error("Hermes image attachment is empty");
  const decodedBytes = Math.floor(contentBase64.length * 3 / 4);
  if (decodedBytes > MAX_IMAGE_BYTES) throw new Error(`Hermes image attachment exceeds ${MAX_IMAGE_BYTES} bytes`);
  return {
    kind: "bytes",
    contentBase64,
    filename: `image-${index + 1}.${imageExtension(match[1]!)}`,
  };
}

async function remoteImage(url: string, index: number): Promise<HermesImageInput> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!mimeType.startsWith("image/")) throw new Error(`unexpected content type ${mimeType || "unknown"}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
    if (response.body === null) throw new Error("empty response body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      kind: "bytes",
      contentBase64: bytesToBase64(bytes),
      filename: filenameForUrl(url, mimeType, index),
    };
  } catch (error) {
    throw new Error(`Cannot load Hermes image attachment ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function referenceValue(path: string): string {
  if (!/[\s()[\]{}<>"'`]/u.test(path)) return path;
  if (!path.includes("`")) return `\`${path}\``;
  if (!path.includes('"')) return `"${path}"`;
  if (!path.includes("'")) return `'${path}'`;
  return path;
}

async function parseInput(input: unknown): Promise<ParsedInput> {
  if (!Array.isArray(input)) throw new Error("Hermes input must be an array");
  const body: string[] = [];
  const content: Record<string, unknown>[] = [];
  const images: Array<HermesImageInput | Promise<HermesImageInput>> = [];
  for (const [index, rawPart] of input.entries()) {
    const part = record(rawPart);
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" && typeof part.text === "string") {
      body.push(part.text);
      content.push({ ...part, type: "text", text: part.text, text_elements: Array.isArray(part.text_elements) ? part.text_elements : [] });
      continue;
    }
    if (type === "image" && typeof part.url === "string" && part.url !== "") {
      const parsed = parseDataImage(part.url, index);
      if (parsed !== null) images.push(parsed);
      else if (/^https?:\/\//iu.test(part.url)) images.push(remoteImage(part.url, index));
      else throw new Error(`Hermes cannot read image URL scheme: ${part.url.split(":", 1)[0] || "unknown"}`);
      content.push({ ...part, type: "image", url: part.url });
      continue;
    }
    if (type === "localImage" && typeof part.path === "string" && part.path !== "") {
      images.push({ kind: "path", path: part.path });
      content.push({ ...part, type: "localImage", path: part.path });
      continue;
    }
    if (type === "mention" && typeof part.name === "string" && typeof part.path === "string") {
      body.push(`@file:${referenceValue(part.path)}`);
      content.push({ ...part, type: "mention", name: part.name, path: part.path });
      continue;
    }
    if (type === "skill" && typeof part.name === "string" && typeof part.path === "string") {
      body.push(`/${part.name}`);
      content.push({ ...part, type: "skill", name: part.name, path: part.path });
      continue;
    }
    throw new Error(`Hermes bridge does not support AppServer input type: ${type || "unknown"}`);
  }
  return { body: body.join(""), content, images: await Promise.all(images) };
}

function imageDirective(value: string): string | null {
  const match = /^@image:(.*)$/u.exec(value.trim());
  if (match === null) return null;
  const raw = match[1]!.trim();
  return raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1).replaceAll("\\`", "`") : raw;
}

const HERMES_FILE_REFERENCE_RE = /@file:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/gu;
const HERMES_REFERENCE_TRAILING_PUNCTUATION_RE = /[,.;!?]+$/u;
const STAGED_ATTACHMENT_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(.+)$/iu;

function unwrapHermesReferenceValue(raw: string): string {
  if (raw.length >= 2) {
    const head = raw[0];
    const tail = raw.at(-1);
    if ((head === "`" && tail === "`") || (head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw.replace(HERMES_REFERENCE_TRAILING_PUNCTUATION_RE, "");
}

function fileReferenceName(path: string, explicitName?: string): string {
  if (explicitName?.trim()) return explicitName.trim();
  const normalized = path.replace(/\\/gu, "/");
  const basename = normalized.split("/").at(-1) ?? path;
  if (!/(?:^|\/)opencraft-attachments\/[^/]+$/u.test(normalized)) return path;
  return STAGED_ATTACHMENT_NAME_RE.exec(basename)?.[1] ?? basename;
}

function userMessageContent(message: HermesMessage): Record<string, unknown>[] {
  const source = Array.isArray(message.content) ? message.content : [message.text ?? message.content];
  const result: Record<string, unknown>[] = [];
  const referencedPaths = new Set<string>();
  const deferredPaths: string[] = [];
  let hasNativeImage = false;
  const appendFileReference = (path: string, name?: string) => {
    if (path === "" || referencedPaths.has(path)) return;
    referencedPaths.add(path);
    result.push({ type: "mention", name: fileReferenceName(path, name), path });
  };
  const appendText = (value: string) => {
    const kept: string[] = [];
    const before = deferredPaths.length;
    for (const line of value.split("\n")) {
      const path = imageDirective(line);
      if (path === null) kept.push(line);
      else deferredPaths.push(path);
    }
    let body = kept.join("\n").trim();
    if (deferredPaths.length > before) body = body.replace(/^\[screenshot\]\n?/gmu, "").trim();
    const fileReferences: string[] = [];
    body = body.replace(HERMES_FILE_REFERENCE_RE, (_match, raw: string) => {
      fileReferences.push(unwrapHermesReferenceValue(raw));
      return "";
    }).replace(/[ \t]{2,}/gu, " ").trim();
    if (body !== "") result.push({ type: "text", text: body, text_elements: [] });
    for (const path of fileReferences) appendFileReference(path);
  };
  for (const rawPart of source) {
    if (typeof rawPart === "string") {
      appendText(rawPart);
      continue;
    }
    const part = record(rawPart);
    if (part.type === "text" && typeof part.text === "string") {
      appendText(part.text);
      continue;
    }
    if (part.type === "mention" && typeof part.path === "string") {
      appendFileReference(part.path, typeof part.name === "string" ? part.name : undefined);
      continue;
    }
    const nestedImageUrl = record(part.image_url).url;
    if ((part.type === "image_url" || part.type === "input_image") && typeof nestedImageUrl === "string") {
      hasNativeImage = true;
      result.push({ type: "image", url: nestedImageUrl });
      continue;
    }
    if (part.type === "image" && typeof part.url === "string") {
      hasNativeImage = true;
      result.push({ type: "image", url: part.url });
    }
  }
  if (!hasNativeImage) {
    for (const path of deferredPaths) result.push({ type: "localImage", path });
  }
  return result;
}

function timestamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Math.floor(Date.now() / 1000);
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function messageAddress(message: HermesMessage, index: number): string | number {
  return message.row_id ?? message._row_id ?? (typeof message.id === "number" ? message.id : index);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function reasoningText(message: HermesMessage): string {
  // Hermes aliases the same provider reasoning into more than one durable
  // column. These fields are alternatives, not independent transcript rows.
  for (const value of [message.reasoning, message.reasoning_content, message.reasoning_details]) {
    const body = text(value).trim();
    if (body !== "") return body;
  }
  return "";
}

interface StoredToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function storedToolCalls(message: HermesMessage, address: string | number): StoredToolCall[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((value, index) => {
    const row = record(value);
    const fn = record(row.function);
    const input = record(row.input);
    const id = typeof row.id === "string" && row.id !== ""
      ? row.id
      : typeof row.tool_call_id === "string" && row.tool_call_id !== ""
        ? row.tool_call_id
        : `${address}-${index}`;
    const name = [row.name, row.tool_name, fn.name, input.name]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate !== "") ?? "tool";
    const argumentsValue = [fn.arguments, row.arguments, row.args, row.input]
      .map(parseObject)
      .find((candidate) => Object.keys(candidate).length > 0) ?? {};
    return { id, name, arguments: argumentsValue };
  });
}

function toolResultText(message: HermesMessage): string {
  const value = message.content ?? message.text ?? message.context;
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolFailed(message: HermesMessage, resultText: string): boolean {
  const disposition = typeof message.effect_disposition === "string" ? message.effect_disposition.toLowerCase() : "";
  if (["error", "failed", "denied", "rejected"].includes(disposition)) return true;
  try {
    const result = record(JSON.parse(resultText));
    return toolOutcome(result) === false;
  } catch {
    return false;
  }
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Project Hermes' durable transcript protocol into AppServer Items.
 *
 * A persisted assistant row owns a tool declaration; the following `tool`
 * row owns only its result. `tool_call_id` is therefore the identity join,
 * never the physical database row. This mirrors Hermes Desktop hydration and
 * keeps live and restored conversations on the same Item model.
 */
function projectTurnItems(sessionId: string, entries: Array<{ message: HermesMessage; index: number }>): AppServerTurn["items"] {
  const items: AppServerTurn["items"] = [];
  const toolsByCallId = new Map<string, number>();

  for (const { message, index } of entries) {
    if (message.display_kind === "hidden") continue;
    const address = messageAddress(message, index);

    if (message.role === "user") {
      items.push({
        type: "userMessage",
        id: `hermes-${sessionId}-${address}`,
        clientId: null,
        content: userMessageContent({ ...message, content: message.display_content ?? message.content }),
      });
      continue;
    }

    if (message.role === "assistant") {
      const reasoning = reasoningText(message);
      if (reasoning !== "") {
        items.push({
          type: "reasoning",
          id: `hermes-reasoning-${sessionId}-${address}`,
          summary: [],
          content: [reasoning],
        });
      }

      const calls = storedToolCalls(message, address);
      const body = messageText(message).trim();
      if (body !== "") {
        items.push({
          type: "agentMessage",
          id: `hermes-agent-${sessionId}-${address}`,
          text: body,
          // Text emitted on a tool-call round is narration inside Activity;
          // only a terminal assistant row owns the final answer lane.
          phase: calls.length > 0 || message.finish_reason === "tool_calls" ? "commentary" : "final_answer",
          memoryCitation: null,
        });
      }

      for (const call of calls) {
        const itemIndex = items.length;
        toolsByCallId.set(call.id, itemIndex);
        items.push({
          type: "dynamicToolCall",
          id: `hermes-tool-${sessionId}-${call.id}`,
          callId: call.id,
          namespace: "hermes",
          tool: call.name,
          arguments: call.arguments,
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        });
      }
      continue;
    }

    if (message.role === "tool") {
      const callId = typeof message.tool_call_id === "string" && message.tool_call_id !== ""
        ? message.tool_call_id
        : null;
      const resultText = toolResultText(message);
      const failed = toolFailed(message, resultText);
      const existingIndex = callId === null ? undefined : toolsByCallId.get(callId);
      if (existingIndex !== undefined) {
        const existing = items[existingIndex]!;
        items[existingIndex] = {
          ...existing,
          status: failed ? "failed" : "completed",
          contentItems: resultText === "" ? [] : [{ type: "inputText", text: resultText }],
          success: failed ? false : toolOutcome(resultText),
        };
      } else {
        const fallbackId = callId ?? String(address);
        const name = [message.tool_name, message.name]
          .find((candidate): candidate is string => typeof candidate === "string" && candidate !== "") ?? "tool";
        const argumentsValue = parseObject(message.args);
        items.push({
          type: "dynamicToolCall",
          id: `hermes-tool-${sessionId}-${fallbackId}`,
          callId: fallbackId,
          namespace: "hermes",
          tool: name,
          arguments: argumentsValue,
          status: failed ? "failed" : "completed",
          contentItems: resultText === "" ? [] : [{ type: "inputText", text: resultText }],
          success: failed ? false : toolOutcome(resultText),
          durationMs: null,
        });
      }
    }
  }

  // Only the terminal text tail can reconcile a repeated final preview.
  // Tool boundaries retain independent narration even when text is equal.
  const lastToolIndex = items.findLastIndex(item => item.type === "dynamicToolCall");
  const lastAgentByText = new Map<string, number>();
  const finalAgentTexts: string[] = [];
  items.forEach((item, index) => {
    if (item.type !== "agentMessage" || typeof item.text !== "string") return;
    const key = normalizeVisibleText(item.text);
    if (key !== "") lastAgentByText.set(key, index);
    if (item.phase === "final_answer" && key !== "") finalAgentTexts.push(key);
  });
  return items.filter((item, index) => {
    if (item.type === "agentMessage" && typeof item.text === "string") {
      const key = normalizeVisibleText(item.text);
      // Equal narration across distinct tool rounds is not duplicate identity.
      // Restrict final-preview reconciliation to the tail after the last tool.
      return index <= lastToolIndex || key === "" || lastAgentByText.get(key) === index;
    }
    if (item.type === "reasoning" && Array.isArray(item.content)) {
      const key = normalizeVisibleText(item.content.filter((value): value is string => typeof value === "string").join("\n"));
      // Same ownership rule as Hermes Desktop's final-text merge: the final
      // answer supersedes reasoning only when it fully starts with it. A short
      // final must never erase a longer, genuinely distinct reasoning trace.
      return index <= lastToolIndex || key === "" || !finalAgentTexts.some((finalText) => finalText.startsWith(key));
    }
    return true;
  }).map(projectHermesTool);
}

interface MappedTurnRange {
  readonly turn: AppServerTurn;
  readonly start: number;
  end: number;
}

function durableMessageTime(message: HermesMessage): number | null {
  return typeof message.timestamp === "number"
    && Number.isFinite(message.timestamp)
    && message.timestamp > 0
    ? message.timestamp
    : null;
}

function applyDurableTurnTime(
  turn: AppServerTurn,
  entries: readonly { message: HermesMessage; index: number }[],
): void {
  const startedAt = entries
    .map(({ message }) => durableMessageTime(message))
    .find((value): value is number => value !== null) ?? null;
  const completedAt = entries
    .filter(({ message }) => message.role === "assistant" || message.role === "tool")
    .map(({ message }) => durableMessageTime(message))
    .filter((value): value is number => value !== null)
    .at(-1) ?? null;
  turn.startedAt = startedAt;
  turn.completedAt = startedAt !== null && completedAt !== null && completedAt >= startedAt
    ? completedAt
    : null;
  turn.durationMs = turn.completedAt === null
    ? null
    : Math.round((turn.completedAt - startedAt!) * 1_000);
}

function mapMessageRanges(sessionId: string, messages: HermesMessage[], running = false): MappedTurnRange[] {
  const turns: MappedTurnRange[] = [];
  let entries: Array<{ message: HermesMessage; index: number }> = [];
  const flush = () => {
    const current = turns.at(-1);
    if (current !== undefined) {
      current.turn.items = projectTurnItems(sessionId, entries);
      applyDurableTurnTime(current.turn, entries);
    }
    entries = [];
  };
  for (const [index, message] of messages.entries()) {
    if (message.display_kind === "hidden" || message.role === "system") continue;
    if (message.role === "user" || turns.length === 0) {
      if (turns.length > 0) flush();
      turns.push({
        start: index,
        end: index + 1,
        turn: {
          id: `hermes-turn-${sessionId}-${messageAddress(message, index)}`,
          items: [], itemsView: "full", status: "completed", error: null,
          startedAt: null, completedAt: null, durationMs: null,
        },
      });
    }
    const current = turns.at(-1)!;
    current.end = index + 1;
    entries.push({ message, index });
  }
  flush();
  if (running && turns.length > 0) {
    const active = turns.at(-1)!.turn;
    active.status = "inProgress";
    active.completedAt = null;
    active.durationMs = null;
  }
  return turns;
}

export function mapMessages(sessionId: string, messages: HermesMessage[], running = false): AppServerTurn[] {
  return mapMessageRanges(sessionId, messages, running).map(({ turn }) => turn);
}

function makeThread(summary: HermesSessionSummary, cwd: string, turns: AppServerTurn[] = [], running = false): AppServerThread {
  const when = timestamp(summary.started_at);
  const title = summary.title.trim() || summary.preview.trim() || "New chat";
  return {
    id: summary.id, sessionId: summary.id, extra: { hermes: {
      source: summary.source,
      messageCount: summary.message_count,
      profile: summary.profile ?? "default",
    } },
    forkedFromId: null, parentThreadId: null, preview: title, ephemeral: false, section: null, sectionEnteredAt: null,
    projectId: null, historyMode: "message-window", modelProvider: "hermes", createdAt: when, updatedAt: when, recencyAt: when,
    status: running ? { type: "active", activeFlags: [] } : { type: "idle" }, path: null, cwd,
    cliVersion: "hemesclient/0.2.0", source: { custom: "hermes" }, canAcceptDirectInput: true, threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: title, turns,
  };
}

export function isHermesSessionNotFound(error: unknown): boolean {
  return error instanceof HermesRpcError
    ? error.code === 4007
    : /session not found/iu.test(error instanceof Error ? error.message : String(error));
}

export function hermesThreadMessageCount(thread: AppServerThread): number | null {
  const extra = record(thread.extra);
  const hermes = record(extra.hermes);
  return typeof hermes.messageCount === "number" ? hermes.messageCount : null;
}

/**
 * A freshly-created Hermes runtime is addressable over the Gateway before its
 * first message materializes a Dashboard history row. In that one state, a
 * history 404 means "empty transcript", not "missing conversation".
 *
 * The resumed Thread is the existence authority. Never apply this rule when
 * Hermes reports stored messages, because that would hide a wrong-backend or
 * deleted-history failure behind an empty conversation.
 */
export function isUnmaterializedHermesHistory(
  thread: AppServerThread,
  error: unknown,
): boolean {
  return hermesThreadMessageCount(thread) === 0 && isHermesSessionNotFound(error);
}

interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  archived?: boolean | null;
  searchTerm?: string | null;
  sortDirection?: "asc" | "desc" | null;
  profile?: string | null;
  includeHidden?: boolean;
  /** Exact server-side named-session lookup, not a recency-window search. */
  exactTitle?: string | null;
}

interface ThreadStartOptions {
  title?: string;
  hidden?: boolean;
  followProfileConfig?: boolean;
}

interface HermesProjectionScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

interface HermesAdmissionProjection {
  readonly projection: HermesTurnEventStateMachine;
  readonly events: Array<{
    readonly event: Record<string, unknown>;
    readonly occurredAtMs: number;
  }>;
}

const DEFAULT_PROJECTION_SCHEDULER: HermesProjectionScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface HermesTurnSubmission {
  readonly turn: AppServerTurn;
  readonly disposition: "running" | "queued";
}

export interface HermesAppServerInteractionRequest {
  readonly id: string;
  readonly method: "item/tool/requestUserInput";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly questions: Array<{
      readonly id: string;
      readonly header: string;
      readonly question: string;
      readonly isOther: boolean;
      readonly isSecret: boolean;
      readonly options: Array<{ readonly label: string; readonly description: string }> | null;
    }>;
    readonly isBlocking: true;
    readonly autoResolutionMs: null;
  };
}

interface PendingClarifyOwnership {
  readonly appServerRequest: HermesAppServerInteractionRequest;
  readonly hermesRequestId: string;
  readonly liveSessionId: string;
  readonly payload: HermesPendingClarify;
}

export class HermesAppServerAdapter {
  private readonly liveByStored = new Map<string, string>();
  private readonly payloadByStored = new Map<string, HermesSessionPayload>();
  private readonly storedByLive = new Map<string, string>();
  private readonly profileByStored = new Map<string, string>();
  /**
   * `session.create` is the existence authority for a new live session. Hermes
   * Dashboard history is eventually consistent and may omit that session from
   * `session.list` until the first message has been indexed. Keep the exact
   * metadata returned to AppServer so an immediate Draft promotion can read
   * the Thread without mistaking an unindexed history row for deletion.
   */
  private readonly provisionalSummaryByStored = new Map<string, HermesSessionSummary>();
  /** Cold deep links share one Host-side identity discovery transaction. */
  private readonly profileDiscoveryByStored = new Map<string, Promise<string>>();
  /**
   * One projection owner per physical Hermes session.
   *
   * A completed owner is deliberately retained until the next activation or
   * local Turn. Draft promotion may race the terminal Hermes frame; replacing
   * this owner during `thread/resume` would replay the same physical response
   * through a second AppServer Item identity.
   */
  private readonly activeByLive: Map<string, HermesTurnEventStateMachine>;
  /** Server-accepted follow-ups waiting behind the physical session lease. */
  private readonly pendingByLive: Map<string, HermesTurnEventStateMachine[]>;
  /** A queued Turn cannot consume frames until the previous run's idle boundary. */
  private readonly queuedBoundaryPendingByLive: Set<string>;
  /** Serializes admission only; it never waits for the running Turn to finish. */
  private readonly submissionTailByLive = new Map<string, Promise<void>>();
  /**
   * A candidate Turn cannot own the live event stream before prompt.submit has
   * returned. Frames crossing that transaction boundary are retained here and
   * committed only when Hermes confirms that this exact submission is running.
   */
  private readonly admissionByLive = new Map<string, HermesAdmissionProjection>();
  private readonly settlementTimerByLive = new Map<string, unknown>();
  private readonly composerQueue: HermesComposerQueueService;
  private readonly scheduledQueueDrainByStored = new Set<string>();
  private readonly itemsByTurnId = new Map<string, AppServerTurn["items"]>();
  private readonly itemCacheOrder: string[] = [];
  private readonly transcriptWindows = new Map<string, HermesTranscriptWindow>();
  private readonly transcriptSnapshots: Map<string, HermesTranscriptWindowSnapshot>;
  /** One cursor-zero history page shared by Resume and its first page read. */
  private readonly preparedHistoryByStored = new Map<string, {
    readonly limit: number;
    readonly sortDirection: "asc" | "desc";
    readonly page: {
      data: AppServerTurn[];
      chronological: AppServerTurn[];
      nextOffset: number | null;
    };
  }>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequestListeners = new Set<(request: HermesAppServerInteractionRequest) => void>();
  private readonly pendingClarifyByRequest = new Map<string, PendingClarifyOwnership>();
  /** `running=false` means waiting-for-input while this barrier exists, not Turn completion. */
  private readonly stopGatewayEvents: () => void;
  private readonly stopComposerQueue: () => void;

  constructor(
    private readonly gateway: HermesRpcClient,
    private readonly defaultCwd: string,
    private readonly history?: HermesHistoryClient,
    private readonly projectionScheduler: HermesProjectionScheduler = DEFAULT_PROJECTION_SCHEDULER,
    recovery?: HermesProjectionRecovery,
    composerQueue: HermesComposerQueueService = new MemoryHermesComposerQueueService(),
  ) {
    this.composerQueue = composerQueue;
    this.activeByLive = recovery?.owners ?? new Map();
    this.pendingByLive = recovery?.pending ?? new Map();
    this.queuedBoundaryPendingByLive = recovery?.queuedBoundaries ?? new Set();
    this.transcriptSnapshots = recovery?.transcriptWindows ?? new Map();
    this.stopGatewayEvents = gateway.onEvent((event) => this.projectGatewayEvent(event));
    this.stopComposerQueue = composerQueue.subscribe((threadId) => this.emitQueueChanged(threadId));
  }

  dispose(): void {
    for (const window of this.transcriptWindows.values()) window.invalidate();
    this.transcriptWindows.clear();
    this.preparedHistoryByStored.clear();
    this.stopGatewayEvents();
    this.stopComposerQueue();
    for (const handle of this.settlementTimerByLive.values()) this.projectionScheduler.cancel(handle);
    this.settlementTimerByLive.clear();
    this.admissionByLive.clear();
    this.notificationListeners.clear();
    this.serverRequestListeners.clear();
    this.pendingClarifyByRequest.clear();
    this.provisionalSummaryByStored.clear();
  }

  subscribeNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** AppServer, not the transcript, owns blocking user interaction lifecycle. */
  subscribeServerRequest(listener: (request: HermesAppServerInteractionRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    for (const pending of this.pendingClarifyByRequest.values()) listener(pending.appServerRequest);
    return () => this.serverRequestListeners.delete(listener);
  }

  async respondServerRequest(requestId: string, result: unknown): Promise<boolean> {
    const pending = this.pendingClarifyByRequest.get(requestId);
    if (pending === undefined) return false;
    const response = record(result);
    const answers = record(response.answers);
    const questions = pending.appServerRequest.params.questions;
    const rawQuestions = Array.isArray(pending.payload.questions)
      ? pending.payload.questions.map(record)
      : [];

    if (rawQuestions.length > 0) {
      for (const [index, question] of questions.entries()) {
        const values = record(answers[question.id]).answers;
        const selected = Array.isArray(values)
          ? values.filter((value): value is string => typeof value === "string")
          : [];
        const raw = rawQuestions[index] ?? {};
        const answer = raw.multi_select === true && selected.length > 1
          ? JSON.stringify(selected)
          : selected[0] ?? "";
        await this.gateway.call("clarify.respond", {
          request_id: pending.hermesRequestId,
          question_id: question.id,
          answer,
        });
      }
    } else {
      const values = record(answers.answer).answers;
      const selected = Array.isArray(values)
        ? values.filter((value): value is string => typeof value === "string")
        : [];
      const answer = pending.payload.multi_select === true && selected.length > 1
        ? JSON.stringify(selected)
        : selected[0] ?? "";
      await this.gateway.call("clarify.respond", {
        request_id: pending.hermesRequestId,
        answer,
      });
    }
    this.expirePendingClarify(pending.liveSessionId, pending.hermesRequestId);
    return true;
  }

  rejectServerRequest(requestId: string, error: unknown): boolean {
    const pending = this.pendingClarifyByRequest.get(requestId);
    if (pending === undefined) return false;
    // A presentation failure does not answer the backend's blocking request.
    this.emit("error", {
      threadId: pending.appServerRequest.params.threadId,
      error: { message: `Could not present Hermes clarification: ${JSON.stringify(error)}` },
    });
    return true;
  }

  async listThreads(params: ThreadListParams = {}) {
    if (params.archived === true) return { data: [], nextCursor: null, backwardsCursor: null };
    const profile = params.profile?.trim() || null;
    const response = await this.gateway.call<{ sessions: HermesSessionSummary[] }>("session.list", {
      limit: 1000,
      ...(profile === null ? {} : { profile }),
      ...(params.includeHidden === true ? { include_hidden: true } : {}),
      ...(params.exactTitle?.trim() ? { title: params.exactTitle.trim() } : {}),
    });
    for (const row of response.sessions) {
      this.profileByStored.set(row.id, row.profile?.trim() || profile || "default");
    }
    const query = params.searchTerm?.trim().toLocaleLowerCase();
    let rows = response.sessions.filter((row) => (
      (!params.exactTitle?.trim()
        || row.root_title?.trim() === params.exactTitle.trim()
        || (!row.root_title?.trim() && row.title.trim() === params.exactTitle.trim()))
      && (!query || `${row.title} ${row.preview}`.toLocaleLowerCase().includes(query))
    ));
    if (params.sortDirection === "asc") rows = [...rows].reverse();
    const offset = params.cursor?.startsWith("hermes:") ? Number(params.cursor.slice(7)) || 0 : 0;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    return {
      data: rows.slice(offset, offset + limit).map((row) => makeThread(row, this.payloadByStored.get(row.id)?.info?.cwd ?? this.defaultCwd)),
      nextCursor: offset + limit < rows.length ? `hermes:${offset + limit}` : null,
      backwardsCursor: offset > 0 ? `hermes:${Math.max(0, offset - limit)}` : null,
    };
  }

  async readThreadMetadata(threadId: string, signal?: AbortSignal): Promise<AppServerThread> {
    const profile = await this.resolveThreadProfile(threadId);
    throwIfSignalAborted(signal);
    const list = await this.gateway.call<{ sessions: HermesSessionSummary[] }>("session.list", { profile, limit: 1000 });
    throwIfSignalAborted(signal);
    const summary = list.sessions.find(session => session.id === threadId);
    if (summary !== undefined) {
      this.provisionalSummaryByStored.delete(threadId);
      return makeThread(summary, this.payloadByStored.get(threadId)?.info?.cwd ?? this.defaultCwd);
    }
    const provisional = this.provisionalSummaryByStored.get(threadId);
    if (provisional === undefined) throw new Error(`Hermes session not found: ${threadId}`);
    return makeThread(
      provisional,
      this.payloadByStored.get(threadId)?.info?.cwd ?? this.defaultCwd,
      [],
      this.payloadByStored.get(threadId)?.running === true,
    );
  }

  async loadThread(threadId: string, includeTurns: boolean, requestedProfile?: string | null, signal?: AbortSignal): Promise<AppServerThread> {
    throwIfSignalAborted(signal);
    const profile = requestedProfile?.trim()
      || this.profileByStored.get(threadId)
      || await this.resolveThreadProfile(threadId);
    this.profileByStored.set(threadId, profile);
    const historyPromise = includeTurns ? this.readTurnsPage(threadId, 0, 120, "desc", signal) : null;
    const [payload, list, historyPage] = await Promise.all([
      this.resume(threadId, profile),
      this.gateway.call<{ sessions: HermesSessionSummary[] }>("session.list", {
        limit: 1000,
        ...(profile === null ? {} : { profile }),
      }),
      historyPromise,
    ]);
    throwIfSignalAborted(signal);
    const summary = list.sessions.find((row) => row.id === threadId) ?? {
      id: threadId, title: "New chat", preview: "", started_at: Date.now() / 1000,
      message_count: payload.message_count, source: "desktop", profile: profile ?? "default",
    };
    this.profileByStored.set(threadId, summary.profile?.trim() || profile || "default");
    const turns = historyPage?.chronological ?? [];
    return makeThread(summary, payload.info?.cwd ?? this.defaultCwd, turns, payload.running === true);
  }

  /** Resolve a server-owned named session without depending on list visibility. */
  async resolveNamedThread(profile: string, title: string): Promise<AppServerThread | null> {
    let payload: HermesSessionPayload;
    try {
      payload = await this.gateway.call<HermesSessionPayload>("session.resume", {
        session_id: title,
        defer_history: true,
        omit_messages: true,
        profile,
      });
    } catch (error) {
      if (isHermesSessionNotFound(error)) return null;
      throw error;
    }
    const stored = payload.stored_session_id?.trim() || payload.resumed?.trim();
    if (!stored) {
      throw new Error(`Hermes named-session resume did not return a durable identity for ${title}`);
    }
    this.bindSession(stored, payload, profile);
    return makeThread({
      id: stored,
      title,
      root_title: title,
      preview: "",
      started_at: Date.now() / 1000,
      message_count: payload.message_count,
      source: "desktop",
      profile,
    }, payload.info?.cwd ?? this.defaultCwd, [], payload.running === true);
  }

  async readTurnsPage(
    threadId: string,
    offset: number,
    limit: number,
    sortDirection: "asc" | "desc",
    signal?: AbortSignal,
  ): Promise<{
    data: AppServerTurn[];
    chronological: AppServerTurn[];
    nextOffset: number | null;
  }> {
    throwIfSignalAborted(signal);
    const prepared = this.preparedHistoryByStored.get(threadId);
    if (
      offset === 0
      && prepared !== undefined
      && prepared.sortDirection === sortDirection
    ) {
      this.preparedHistoryByStored.delete(threadId);
      return prepared.page;
    }
    return this.fetchTurnsPage(threadId, offset, limit, sortDirection, signal);
  }

  /**
   * Fetches the authoritative tail once for a cursor-only Resume. The next
   * matching thread/turns/list consumes this exact page, so runtime binding and
   * transcript hydration cannot observe two different history snapshots.
   */
  async prepareTurnsPage(
    threadId: string,
    limit: number,
    sortDirection: "asc" | "desc",
    signal?: AbortSignal,
  ): Promise<{
    data: AppServerTurn[];
    chronological: AppServerTurn[];
    nextOffset: number | null;
  }> {
    const page = await this.fetchTurnsPage(threadId, 0, limit, sortDirection, signal);
    throwIfSignalAborted(signal);
    this.preparedHistoryByStored.set(threadId, { limit, sortDirection, page });
    return page;
  }

  private async fetchTurnsPage(
    threadId: string,
    offset: number,
    limit: number,
    sortDirection: "asc" | "desc",
    signal?: AbortSignal,
  ): Promise<{
    data: AppServerTurn[];
    chronological: AppServerTurn[];
    nextOffset: number | null;
  }> {
    if (!this.history) throw new Error("Hermes durable history port is unavailable");
    // Desktop paginates transcript rows, never scans for a complete execution
    // Turn. A window may start inside an assistant/tool sequence. Its groups
    // are presentation projections and can regroup when older rows arrive.
    const profile = this.profileByStored.get(threadId) ?? await this.resolveThreadProfile(threadId);
    throwIfSignalAborted(signal);
    const key = JSON.stringify([profile, threadId]);
    let window = this.transcriptWindows.get(key);
    if (!window) {
      window = new HermesTranscriptWindow(this.history, threadId, profile, this.transcriptSnapshots.get(key));
      this.transcriptWindows.set(key, window);
    }
    const page = offset === 0 ? await window.readTail(signal) : await window.readOlder(signal, offset);
    throwIfSignalAborted(signal);
    if (this.transcriptWindows.get(key) !== window) throw new Error("Hermes history window was invalidated");
    this.transcriptSnapshots.delete(key);
    this.transcriptSnapshots.set(key, page);
    // Desktop's transcript-tail bookkeeping is bounded to 256 scoped entries.
    while (this.transcriptSnapshots.size > 256) {
      const oldest = this.transcriptSnapshots.keys().next().value!;
      this.transcriptSnapshots.delete(oldest);
      this.transcriptWindows.get(oldest)?.invalidate();
      this.transcriptWindows.delete(oldest);
    }
    // The durable transport is row-paged while AppServer is Turn-paged. Keep
    // the larger Desktop-compatible row window cached, but project only the
    // requested Turn slice. The cursor remains a count from the newest row,
    // so subsequent pages can be served from this window until its older edge
    // is reached and the transport must backfill again.
    const end = Math.max(0, page.messages.length - offset);
    const eligible = mapMessageRanges(threadId, [...page.messages])
      .filter(({ end: rangeEnd }) => rangeEnd <= end);
    const selected = eligible.slice(-limit);
    const chronological = selected.map(({ turn }) => ({
      ...turn, historyWindowId: key,
    }));
    for (const turn of chronological) this.cacheTurnItems(turn);
    const consumedOffset = selected.length > 0
      ? page.messages.length - selected[0]!.start
      : Math.max(offset, page.nextOffset);
    const nextOffset = eligible.length > selected.length || page.possiblyTruncated
      ? consumedOffset
      : null;
    return {
      data: sortDirection === "desc" ? [...chronological].reverse() : chronological,
      chronological,
      nextOffset,
    };
  }

  async activateProjection(threadId: string, turns: AppServerTurn[]): Promise<{ replayComplete: boolean }> {
    let payload = this.payloadByStored.get(threadId);
    if (!payload) throw new Error(`Hermes runtime is not bound for Thread ${threadId}`);
    const live = payload.session_id;
    this.offerPendingClarify(
      live,
      threadId,
      turns.at(-1) ?? null,
      payload.pending_clarify,
    );
    const owned = this.activeByLive.get(live);

    // A locally-started Turn already owns this Hermes stream. Activation only
    // attaches the View to that owner; it must never manufacture a second
    // projection state machine from the history tail. This remains true after
    // completion: catch-up frames are then harmlessly absorbed by the settled
    // owner instead of being projected as a second response.
    if (owned !== undefined) {
      const replay = await this.gateway.catchUpSession?.(live) ?? { complete: true };
      if (replay.complete && this.activeByLive.get(live) === owned) {
        const index = turns.findIndex(turn => turn.id === owned.turn.id);
        const tail = turns.at(-1);
        if (index >= 0) turns[index] = owned.turn;
        else if (tail && !tail.items.some(item => item.type === "agentMessage" && item.phase !== "commentary")) turns[turns.length - 1] = owned.turn;
        else if (!owned.isCompleted) turns.push(owned.turn);
        this.cacheTurnItems(owned.turn);
        if (owned.isCompleted && !this.pendingByLive.get(live)?.length) {
          this.activeByLive.delete(live);
          this.gateway.discardReplay?.(live);
        }
        return { replayComplete: true };
      }
      // A truncated window/changed epoch cannot extend the retained replica.
      this.activeByLive.delete(live);
      this.pendingByLive.delete(live);
      this.queuedBoundaryPendingByLive.delete(live);
    }

    // No matching replica: never apply an old receive watermark to a history
    // snapshot. Like Desktop's cold activate, read the backend's live tail
    // after REST hydration; events before this response belong to that tail.
    this.gateway.discardReplay?.(live);
    if (this.gateway.snapshotSession && (owned !== undefined || payload.running === true || payload.inflight || payload.pending_clarify)) {
      payload = await this.gateway.snapshotSession(live);
      this.payloadByStored.set(threadId, payload);
    }
    const restored = appendLiveSessionProjection(turns, payload);
    if (restored) this.cacheTurnItems(restored);
    // The fresh snapshot owns pending input on cold recovery. Do not retain a
    // request that disappeared while this client was disconnected.
    for (const pending of this.pendingClarifyByRequest.values()) {
      if (pending.liveSessionId === live && pending.hermesRequestId !== payload.pending_clarify?.request_id) {
        this.expirePendingClarify(live, pending.hermesRequestId);
      }
    }
    this.offerPendingClarify(live, threadId, restored ?? turns.at(-1) ?? null, payload.pending_clarify);

    // An idle durable snapshot owns its own presentation. There is no live
    // Turn to adopt, so installing a projector on its last completed Turn
    // would incorrectly turn history into an active response during replay.
    // `pending_clarify` is the intentional exception: Hermes reports idle
    // while its physical Turn is blocked inside the clarify tool.
    if (payload.running !== true && payload.pending_clarify === undefined) {
      this.gateway.releaseSnapshot?.(live);
      return { replayComplete: true };
    }

    const lastTurn = restored ?? turns.at(-1) ?? {
      id: `hermes-turn-${threadId}-live`,
      items: [],
      itemsView: "full" as const,
      status: "inProgress" as const,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
    // No local owner exists, so this is an adopted externally-running Turn.
    // Install its sole owner before releasing replay.
    this.activeByLive.set(live, new HermesTurnEventStateMachine(threadId, lastTurn));
    lastTurn.status = "inProgress";
    if (!turns.includes(lastTurn)) turns.push(lastTurn);
    this.gateway.releaseSnapshot?.(live);
    return { replayComplete: true };
  }

  readTurnItems(turnId: string): AppServerTurn["items"] {
    const items = this.itemsByTurnId.get(turnId);
    if (!items) throw new Error(`Hermes turn not found: ${turnId}`);
    return items;
  }

  publishHistoryPreview(threadId: string, token: string, turns: readonly AppServerTurn[]): void {
    this.emit("thread/history/preview", { threadId, token, turns });
  }

  async listModels(params: {
    cursor?: unknown;
    limit?: unknown;
    includeHidden?: unknown;
    threadId?: unknown;
  } = {}) {
    const threadId = typeof params.threadId === "string" && params.threadId.trim() !== ""
      ? params.threadId.trim()
      : null;
    const profile = threadId === null
      ? null
      : this.profileByStored.get(threadId) ?? await this.resolveThreadProfile(threadId);
    const liveSessionId = threadId === null
      ? null
      : this.liveByStored.get(threadId) ?? threadId;
    const payload = await this.gateway.call<HermesModelOptionsPayload>(
      "model.options",
      {
        explicit_only: params.includeHidden !== true,
        ...(liveSessionId === null ? {} : { session_id: liveSessionId }),
        ...(profile === null ? {} : { profile }),
      },
    );
    const all = mapHermesModelOptions(payload).filter(
      (model) => params.includeHidden === true || !model.hidden,
    );
    const offset = typeof params.cursor === "string" && /^hermes-models:\d+$/u.test(params.cursor)
      ? Number(params.cursor.slice("hermes-models:".length))
      : 0;
    const limit = typeof params.limit === "number"
      ? Math.min(Math.max(Math.floor(params.limit), 1), 200)
      : 100;
    return {
      data: all.slice(offset, offset + limit),
      nextCursor: offset + limit < all.length
        ? `hermes-models:${offset + limit}`
        : null,
    };
  }

  executionModel(threadId: string): string {
    const info = this.payloadByStored.get(threadId)?.info;
    return modelSelectionFromExecution(info?.model, info?.provider);
  }

  private cacheTurnItems(turn: AppServerTurn): void {
    this.itemsByTurnId.set(turn.id, turn.items);
    const previous = this.itemCacheOrder.indexOf(turn.id);
    if (previous >= 0) this.itemCacheOrder.splice(previous, 1);
    this.itemCacheOrder.push(turn.id);
    while (this.itemCacheOrder.length > 1_000) {
      const oldest = this.itemCacheOrder.shift();
      if (oldest !== undefined) this.itemsByTurnId.delete(oldest);
    }
  }

  async startThread(
    cwd?: string | null,
    requestedModel?: unknown,
    requestedProfile?: string | null,
    options: ThreadStartOptions = {},
  ): Promise<AppServerThread> {
    const selection = decodeHermesModelSelection(requestedModel);
    const profile = requestedProfile?.trim() || null;
    const payload = await this.gateway.call<HermesSessionPayload>("session.create", {
      cwd: cwd ?? this.defaultCwd,
      source: "desktop",
      ...(profile === null ? {} : { profile }),
      ...(options.title?.trim() ? { title: options.title.trim() } : {}),
      ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
      ...(options.followProfileConfig === undefined ? {} : { follow_profile_config: options.followProfileConfig }),
      ...(selection === null ? {} : { model: selection.model }),
      ...(selection?.provider == null ? {} : { provider: selection.provider }),
    });
    const stored = payload.stored_session_id ?? payload.session_id;
    this.liveByStored.set(stored, payload.session_id);
    this.storedByLive.set(payload.session_id, stored);
    this.payloadByStored.set(stored, payload);
    this.profileByStored.set(stored, profile ?? "default");
    const summary: HermesSessionSummary = {
      id: stored,
      title: options.title?.trim() || "New chat",
      preview: "",
      started_at: Date.now() / 1000,
      message_count: 0,
      source: "desktop",
      profile: profile ?? "default",
    };
    this.provisionalSummaryByStored.set(stored, summary);
    return makeThread(summary, payload.info?.cwd ?? cwd ?? this.defaultCwd);
  }

  /**
   * Turn a lazy live Hermes draft into an addressable durable session.
   * Navigation must never publish the stored id before this transaction ends.
   */
  async materializeThread(threadId: string, title: string, hidden: boolean): Promise<void> {
    const live = await this.ensureLive(threadId);
    const titled = await this.gateway.call<{ pending?: boolean }>("session.title", {
      session_id: live,
      title,
    });
    if (titled.pending === true) {
      throw new Error(`Hermes did not durably materialize session ${threadId}`);
    }
    await this.gateway.call("session.set_hidden", {
      session_id: live,
      hidden,
    });
  }

  async startTurn(
    threadId: string,
    input: unknown,
    requestedModel?: unknown,
    requestedProfile?: string | null,
    clientUserMessageId: string | null = null,
  ): Promise<AppServerTurn> {
    const submission = await this.submitTurn(
      threadId,
      input,
      requestedModel,
      requestedProfile,
      clientUserMessageId,
      false,
    );
    return submission.turn;
  }

  /**
   * Bot traffic uses Hermes' strict queue contract. The returned disposition
   * is transport fact, not UI inference: a busy physical session owns exactly
   * one live process and later messages remain FIFO server work.
   */
  async submitBotTurn(
    threadId: string,
    input: unknown,
    clientUserMessageId: string,
    requestedModel?: unknown,
    requestedProfile?: string | null,
  ): Promise<HermesTurnSubmission> {
    return await this.submitTurn(
      threadId,
      input,
      requestedModel,
      requestedProfile,
      clientUserMessageId,
      true,
    );
  }

  private async submitTurn(
    threadId: string,
    input: unknown,
    requestedModel: unknown,
    requestedProfile: string | null | undefined,
    clientUserMessageId: string | null,
    allowWhileTurnUnsettled: boolean,
  ): Promise<HermesTurnSubmission> {
    const parsed = await parseInput(input);
    if (parsed.body.trim() === "" && parsed.images.length === 0) throw new Error("Hermes input is empty");
    const live = await this.ensureLive(threadId, requestedProfile);
    return await this.withSubmissionAdmission(live, async () => {
      return await this.submitTurnAgainstLive(
        threadId,
        live,
        parsed,
        requestedModel,
        clientUserMessageId,
        allowWhileTurnUnsettled,
      );
    });
  }

  private async submitTurnAgainstLive(
    threadId: string,
    live: string,
    parsed: Awaited<ReturnType<typeof parseInput>>,
    requestedModel: unknown,
    clientUserMessageId: string | null,
    allowWhileTurnUnsettled: boolean,
  ): Promise<HermesTurnSubmission> {
    const previousOwner = this.activeByLive.get(live);
    // AppServer admission is owned by unsettled logical Turns, not by a
    // cached physical-process heartbeat. A completed owner can coexist with
    // running=true while Hermes releases its lease; prompt.submit(queued)
    // alone decides whether the next Turn runs immediately or waits FIFO.
    const hasUnsettledTurn = (previousOwner !== undefined && !previousOwner.isCompleted)
      || (this.pendingByLive.get(live)?.length ?? 0) > 0;
    if (!allowWhileTurnUnsettled && hasUnsettledTurn) {
      throw new Error(`Hermes thread is already running: ${threadId}`);
    }
    await this.applyModelSelection(threadId, live, requestedModel);
    const turn: AppServerTurn = {
      id: `hermes-turn-${crypto.randomUUID()}`,
      items: [{
        type: "userMessage",
        id: `hermes-user-${crypto.randomUUID()}`,
        clientId: clientUserMessageId,
        content: parsed.content,
      }],
      itemsView: "full", status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null,
    };
    const projection = new HermesTurnEventStateMachine(threadId, turn);
    if (!hasUnsettledTurn) {
      this.admissionByLive.set(live, { projection, events: [] });
    }
    let stagedPaths: string[] = [];
    try {
      stagedPaths = await this.stageImages(live, parsed.images);
      const result = await this.gateway.call<{ status?: string }>("prompt.submit", {
        session_id: live,
        text: parsed.body,
        // This is a physical-admission invariant, not a Composer preference.
        // A client can observe an AppServer Turn as settled while Hermes is
        // still unwinding its process lease. Strict queueing makes that race
        // FIFO instead of redirecting/interruption of the just-finished run.
        queued: true,
      });
      if (result.status === "queued") {
        const admission = this.releaseAdmission(live, projection);
        const pending = this.pendingByLive.get(live) ?? [];
        pending.push(projection);
        this.pendingByLive.set(live, pending);
        this.queuedBoundaryPendingByLive.add(live);
        // The previous idle boundary and even the queued Turn's entire
        // response can arrive before the RPC receipt. Install its pending
        // identity first, then release those frames in their original order.
        if (admission !== undefined) {
          for (const { event, occurredAtMs } of admission.events) {
            this.routeProjectionEvent(live, event, occurredAtMs);
          }
        }
        return { turn, disposition: "queued" };
      }
      const admission = this.releaseAdmission(live, projection);
      this.activeByLive.set(live, projection);
      this.emitProjection(projection.accept(this.projectionScheduler.now()));
      if (admission !== undefined) this.commitAdmissionEvents(live, projection, admission.events);
      return { turn, disposition: "running" };
    } catch (error) {
      await this.rollbackImages(live, stagedPaths);
      this.releaseAdmission(live, projection);
      if (this.activeByLive.get(live) === projection) this.activeByLive.delete(live);
      const pending = this.pendingByLive.get(live);
      if (pending !== undefined) {
        const index = pending.indexOf(projection);
        if (index >= 0) pending.splice(index, 1);
        if (pending.length === 0) this.pendingByLive.delete(live);
      }
      throw error;
    }
  }

  private async withSubmissionAdmission<T>(live: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.submissionTailByLive.get(live) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.submissionTailByLive.set(live, tail);
    try {
      return await result;
    } finally {
      if (this.submissionTailByLive.get(live) === tail) this.submissionTailByLive.delete(live);
    }
  }

  private releaseAdmission(
    live: string,
    projection: HermesTurnEventStateMachine,
  ): HermesAdmissionProjection | undefined {
    const admission = this.admissionByLive.get(live);
    if (admission?.projection !== projection) return undefined;
    this.admissionByLive.delete(live);
    return admission;
  }

  private commitAdmissionEvents(
    live: string,
    projection: HermesTurnEventStateMachine,
    events: HermesAdmissionProjection["events"],
  ): void {
    // A busy heartbeat can still belong to the previous process. Only the
    // message boundary, not running=true, establishes this submission's stream.
    const firstOwnedIndex = events.findIndex(({ event }) => event.type === "message.start");
    if (firstOwnedIndex < 0) return;
    for (const { event, occurredAtMs } of events.slice(firstOwnedIndex)) {
      if (this.activeByLive.get(live) !== projection || projection.isCompleted) break;
      this.projectEventIntoOwner(live, projection, event, occurredAtMs);
    }
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string | null,
    input: unknown,
    clientUserMessageId: string | null,
  ): Promise<{ turnId: string; disposition: "steered" | "queued" }> {
    const parsed = await parseInput(input);
    if (parsed.images.length > 0) throw new Error("Hermes session.steer accepts text only; send the image as a queued follow-up");
    if (parsed.body.trim() === "") throw new Error("Hermes steer input is empty");
    const live = await this.ensureLive(threadId);
    const active = this.activeByLive.get(live);
    if (active === undefined || active.isCompleted) {
      throw new HermesAppServerDomainError(
        `Hermes thread has no active turn: ${threadId}`,
        { code: "TURN_INACTIVE", retryable: false },
      );
    }
    if (expectedTurnId !== null && expectedTurnId !== active.turn.id) {
      throw new HermesAppServerDomainError(
        `Hermes active turn changed: expected ${expectedTurnId}, got ${active.turn.id}`,
        { code: "EXPECTED_TURN_MISMATCH", retryable: true, actualTurnId: active.turn.id },
      );
    }
    // Like Desktop's typed follow-up, skip only Clarify before steering.
    // Both calls use this session's owning Gateway and are issued in order;
    // do not await the skip and leave a window for duplicate submissions.
    this.skipPendingClarify(live);
    const result = await this.gateway.call<{ status?: string }>("session.steer", { session_id: live, text: parsed.body });
    if (result.status === "rejected") throw new Error("Hermes rejected the active-turn steer");
    const acknowledgement = active.acceptSteeringUserMessage(
      parsed.content,
      clientUserMessageId,
      this.projectionScheduler.now(),
    );
    if (acknowledgement.length === 0) {
      // Codex restores an unacknowledged steeringUserMessage when its target
      // Turn settles. Preserve the accepted input as a paused follow-up instead
      // of manufacturing an acknowledgement on a dead Turn or dropping it.
      await this.addQueuedSubmission(
        threadId,
        parsed.content,
        clientUserMessageId ?? `hermes-steer-${crypto.randomUUID()}`,
        "Run ended before this message could be steered. Resume it to send as a follow-up.",
      );
      return { turnId: active.turn.id, disposition: "queued" };
    }
    this.emitProjection(acknowledgement);
    return { turnId: active.turn.id, disposition: "steered" };
  }

  async addQueuedSubmission(
    threadId: string,
    input: unknown,
    clientUserMessageId: string,
    pausedReason: string | null = null,
  ): Promise<QueuedSubmission> {
    this.validateQueuedInput(input);
    const submission: QueuedSubmission = {
      id: `hermes-queue-${crypto.randomUUID()}`,
      input: Array.isArray(input) ? structuredClone(input) : [],
      clientUserMessageId,
      createdAt: this.projectionScheduler.now(),
      pausedReason,
    };
    return await this.composerQueue.add(threadId, submission);
  }

  listQueuedSubmissions(threadId: string, cursor: string | null, limit: number | null) {
    const queue = this.composerQueue.read(threadId);
    const offset = cursor?.startsWith("hermes-queue:") ? Number(cursor.slice(13)) || 0 : 0;
    const size = Math.min(Math.max(limit ?? 50, 1), 200);
    return {
      data: structuredClone(queue.slice(offset, offset + size)),
      nextCursor: offset + size < queue.length ? `hermes-queue:${offset + size}` : null,
    };
  }

  async updateQueuedSubmission(threadId: string, queuedSubmissionId: string, input: unknown): Promise<QueuedSubmission> {
    this.validateQueuedInput(input);
    return await this.composerQueue.update(threadId, queuedSubmissionId, (submission) => ({
      ...submission,
      input: Array.isArray(input) ? structuredClone(input) : [],
      pausedReason: null,
    }));
  }

  async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string): Promise<boolean> {
    return await this.composerQueue.remove(threadId, queuedSubmissionId);
  }

  async reorderQueuedSubmissions(threadId: string, queuedSubmissionIds: string[]): Promise<void> {
    await this.composerQueue.reorder(threadId, queuedSubmissionIds);
  }

  async startQueuedSubmission(threadId: string, queuedSubmissionId?: string | null): Promise<AppServerTurn> {
    const queue = this.composerQueue.read(threadId);
    const selected = queuedSubmissionId == null
      ? queue[0]
      : queue.find((item) => item.id === queuedSubmissionId);
    if (selected === undefined) throw new Error("Hermes queue is empty or the submission no longer exists");
    const leased = await this.composerQueue.withConsumptionLease(threadId, selected.id, async (submission) => {
      const live = await this.ensureLive(threadId);
      const owner = this.activeByLive.get(live);
      if (owner !== undefined && !owner.isCompleted) {
        throw new Error(`Hermes thread is already running: ${threadId}`);
      }
      await this.composerQueue.resume(threadId, submission.id);
      const turn = (await this.submitTurn(
        threadId,
        submission.input,
        undefined,
        undefined,
        submission.clientUserMessageId,
        true,
      )).turn;
      await this.composerQueue.remove(threadId, submission.id);
      return turn;
    }).catch(async (error: unknown) => {
      if (this.composerQueue.read(threadId).some((candidate) => candidate.id === selected.id)) {
        await this.composerQueue.pause(
          threadId,
          selected.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    });
    if (!leased.acquired) {
      throw new Error(`Hermes thread queue is already advancing: ${threadId}`);
    }
    return leased.value;
  }

  async steerQueuedSubmission(
    threadId: string,
    queuedSubmissionId: string,
    expectedTurnId: string,
  ): Promise<{ turnId: string }> {
    const leased = await this.composerQueue.withConsumptionLease(
      threadId,
      queuedSubmissionId,
      async (submission) => {
        await this.composerQueue.resume(threadId, submission.id);
        const result = await this.steerTurn(
          threadId,
          expectedTurnId,
          submission.input,
          submission.clientUserMessageId,
        );
        await this.composerQueue.remove(threadId, submission.id);
        return result;
      },
    ).catch(async (error: unknown) => {
      if (this.composerQueue.read(threadId).some((candidate) => candidate.id === queuedSubmissionId)) {
        await this.composerQueue.pause(
          threadId,
          queuedSubmissionId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    });
    if (!leased.acquired) throw new Error(`Hermes thread queue is already advancing: ${threadId}`);
    return leased.value;
  }

  async cancelTurn(threadId: string): Promise<void> {
    await this.composerQueue.pauseAll(
      threadId,
      "Interrupted before this queued message could run.",
    );
    await this.gateway.call("session.interrupt", { session_id: await this.ensureLive(threadId) });
  }

  private validateQueuedInput(input: unknown): void {
    if (!Array.isArray(input) || input.length === 0) throw new Error("Hermes input is empty");
    let hasContent = false;
    for (const rawPart of input) {
      const part = record(rawPart);
      const type = part.type;
      if (type === "text" && typeof part.text === "string") {
        hasContent ||= part.text.trim() !== "";
        continue;
      }
      if (type === "image" && typeof part.url === "string" && part.url !== "") {
        hasContent = true;
        continue;
      }
      if (type === "localImage" && typeof part.path === "string" && part.path !== "") {
        hasContent = true;
        continue;
      }
      if ((type === "mention" || type === "skill") && typeof part.name === "string" && typeof part.path === "string") {
        hasContent = true;
        continue;
      }
      throw new Error(`Hermes bridge does not support AppServer input type: ${typeof type === "string" ? type : "unknown"}`);
    }
    if (!hasContent) throw new Error("Hermes input is empty");
  }

  private async stageImages(live: string, images: HermesImageInput[]): Promise<string[]> {
    const stagedPaths: string[] = [];
    try {
      for (const image of images) {
        const result = image.kind === "bytes"
          ? await this.gateway.call<{ attached?: boolean; path?: string; message?: string }>("image.attach_bytes", {
              session_id: live,
              content_base64: image.contentBase64,
              filename: image.filename,
            })
          : await this.gateway.call<{ attached?: boolean; path?: string; message?: string }>("image.attach", {
              session_id: live,
              path: image.path,
            });
        if (result.attached !== true || typeof result.path !== "string" || result.path === "") {
          throw new Error(result.message ?? "Hermes did not accept the image attachment");
        }
        stagedPaths.push(result.path);
      }
      return stagedPaths;
    } catch (error) {
      await this.rollbackImages(live, stagedPaths);
      throw error;
    }
  }

  private async rollbackImages(live: string, paths: string[]): Promise<void> {
    await Promise.allSettled(paths.map((path) => this.gateway.call("image.detach", { session_id: live, path })));
  }

  async listProfiles(): Promise<readonly HermesProfileSummary[]> {
    const result = await this.gateway.call<{ profiles?: HermesProfileSummary[] }>(
      "profiles.list",
      { include_sessions: true },
    );
    const profiles = Array.isArray(result.profiles) ? result.profiles : [];
    for (const profile of profiles) {
      const name = profile.name.trim() || "default";
      for (const session of [profile.canonical_session, profile.last_session]) {
        if (typeof session?.id === "string" && session.id.trim() !== "") {
          this.profileByStored.set(session.id, name);
        }
      }
    }
    return profiles;
  }

  createProfile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.gateway.call("profiles.create", params);
  }

  configureProfile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.gateway.call("profiles.configure", params);
  }

  async deleteProfile(name: string): Promise<void> {
    try {
      await this.gateway.call("profiles.delete", { name });
    } catch {
      const result = await this.gateway.call<{ blocked?: boolean; code?: number; hint?: string; output?: string }>(
        "cli.exec",
        { argv: ["profile", "delete", name, "--yes"] },
      );
      if (result.blocked === true || (typeof result.code === "number" && result.code !== 0)) {
        throw new Error(result.hint || result.output || `Could not delete profile ${name}`);
      }
    }
  }

  profileForThread(threadId: string): string {
    return this.profileByStored.get(threadId) ?? "default";
  }

  /**
   * Hermes partitions sessions by Profile while AppServer exposes one Host
   * conversation namespace. The bridge therefore reconstructs that ownership
   * before Resume; routes and React must never carry a Hermes Profile hint.
   */
  private resolveThreadProfile(threadId: string): Promise<string> {
    const known = this.profileByStored.get(threadId);
    if (known !== undefined) return Promise.resolve(known);
    const existing = this.profileDiscoveryByStored.get(threadId);
    if (existing !== undefined) return existing;
    const discovery = this.discoverThreadProfile(threadId).finally(() => {
      if (this.profileDiscoveryByStored.get(threadId) === discovery) {
        this.profileDiscoveryByStored.delete(threadId);
      }
    });
    this.profileDiscoveryByStored.set(threadId, discovery);
    return discovery;
  }

  private async discoverThreadProfile(threadId: string): Promise<string> {
    const profiles = await this.listProfiles();
    const hinted = this.profileByStored.get(threadId);
    if (hinted !== undefined) return hinted;

    const matches = (await Promise.all(profiles.map(async (profile) => {
      const name = profile.name.trim() || "default";
      const result = await this.gateway.call<{ sessions?: HermesSessionSummary[] }>("session.list", {
        profile: name,
        include_hidden: true,
        limit: 1000,
      });
      const row = Array.isArray(result.sessions)
        ? result.sessions.find((session) => session.id === threadId)
        : undefined;
      return row === undefined ? null : { name, row };
    }))).filter((match): match is { name: string; row: HermesSessionSummary } => match !== null);

    if (matches.length === 0) {
      // Lazy named sessions intentionally have neither a durable history row
      // nor list visibility until their first message. Resume is the only
      // authoritative existence check on older Hermes gateways.
      for (const profile of profiles) {
        const name = profile.name.trim() || "default";
        let payload: HermesSessionPayload;
        try {
          payload = await this.gateway.call<HermesSessionPayload>("session.resume", {
            session_id: threadId,
            defer_history: true,
            omit_messages: true,
            profile: name,
          });
        } catch (error) {
          if (isHermesSessionNotFound(error)) continue;
          throw error;
        }
        this.bindSession(threadId, payload, name);
        return name;
      }
      throw new Error(`Hermes session not found: ${threadId}`);
    }
    if (matches.length > 1) throw new Error(`Hermes session identity is ambiguous across Profiles: ${threadId}`);
    const match = matches[0]!;
    this.profileByStored.set(threadId, match.name);
    return match.name;
  }

  private async ensureLive(storedId: string, requestedProfile?: string | null): Promise<string> {
    return this.liveByStored.get(storedId) ?? (await this.resume(storedId, requestedProfile)).session_id;
  }

  private async applyModelSelection(
    storedId: string,
    liveId: string,
    requestedModel: unknown,
  ): Promise<void> {
    const selection = decodeHermesModelSelection(requestedModel);
    if (selection === null) return;
    const current = this.payloadByStored.get(storedId)?.info;
    if (
      current?.model === selection.model &&
      (selection.provider === null || current.provider === selection.provider)
    ) {
      return;
    }
    const result = await this.gateway.call<{
      value?: string;
      confirm_required?: boolean;
      confirm_message?: string;
    }>("config.set", {
      session_id: liveId,
      key: "model",
      value: hermesModelSwitchArgument(selection),
      // Selecting a concrete row in OpenCraft is already an explicit user action.
      confirm_expensive_model: true,
    });
    if (result.confirm_required === true) {
      throw new Error(result.confirm_message || "Hermes requires confirmation for this model");
    }
    const payload = this.payloadByStored.get(storedId);
    if (payload !== undefined) {
      payload.info = {
        ...payload.info,
        model: result.value?.trim() || selection.model,
        ...(selection.provider === null ? {} : { provider: selection.provider }),
      };
    }
  }

  private async resume(storedId: string, requestedProfile?: string | null): Promise<HermesSessionPayload> {
    let payload = this.payloadByStored.get(storedId);
    if (payload === undefined) {
      const profile = requestedProfile?.trim() || this.profileByStored.get(storedId) || null;
      payload = await this.gateway.call<HermesSessionPayload>("session.resume", {
        session_id: storedId,
        defer_history: true,
        omit_messages: true,
        ...(profile === null ? {} : { profile }),
      });
      this.bindSession(storedId, payload, profile ?? "default");
    }
    return payload;
  }

  private bindSession(storedId: string, payload: HermesSessionPayload, profile: string): void {
    const previousLive = this.liveByStored.get(storedId);
    if (previousLive !== undefined && previousLive !== payload.session_id) {
      this.storedByLive.delete(previousLive);
      const owner = this.activeByLive.get(previousLive);
      if (owner !== undefined) {
        this.activeByLive.delete(previousLive);
        this.activeByLive.set(payload.session_id, owner);
        this.clearSettlementTimer(previousLive);
        this.scheduleDeferredSettlement(payload.session_id, owner);
      }
      const pending = this.pendingByLive.get(previousLive);
      if (pending !== undefined) {
        this.pendingByLive.delete(previousLive);
        this.pendingByLive.set(payload.session_id, pending);
      }
      if (this.queuedBoundaryPendingByLive.delete(previousLive)) {
        this.queuedBoundaryPendingByLive.add(payload.session_id);
      }
    }
    this.liveByStored.set(storedId, payload.session_id);
    this.storedByLive.set(payload.session_id, storedId);
    this.payloadByStored.set(storedId, payload);
    this.profileByStored.set(storedId, profile);
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener(method, params);
  }

  private offerPendingClarify(
    liveSessionId: string,
    threadId: string,
    turn: AppServerTurn | null,
    payload: HermesPendingClarify | undefined,
  ): void {
    if (payload === undefined || typeof payload.request_id !== "string" || payload.request_id.trim() === "") return;
    const hermesRequestId = payload.request_id.trim();
    const appServerRequestId = `hermes-clarify:${encodeURIComponent(threadId)}:${encodeURIComponent(hermesRequestId)}`;
    if (this.pendingClarifyByRequest.has(appServerRequestId)) return;

    const rawQuestions = Array.isArray(payload.questions)
      ? payload.questions.map(record)
      : [];
    const questions = rawQuestions.flatMap((candidate, index) => {
      const question = typeof candidate.question === "string" ? candidate.question.trim() : "";
      if (question === "") return [];
      const choices = Array.isArray(candidate.choices)
        ? candidate.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "")
        : [];
      return [{
        id: typeof candidate.qid === "string" && candidate.qid.trim() !== ""
          ? candidate.qid.trim()
          : `q${index}`,
        header: `Question ${index + 1}`,
        question,
        isOther: true,
        isSecret: false,
        options: choices.length === 0
          ? null
          : choices.map((label) => ({ label, description: "" })),
      }];
    });
    if (questions.length === 0) {
      const question = typeof payload.question === "string" ? payload.question.trim() : "";
      if (question === "") return;
      const choices = Array.isArray(payload.choices)
        ? payload.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "")
        : [];
      questions.push({
        id: "answer",
        header: "Clarify",
        question,
        isOther: true,
        isSecret: false,
        options: choices.length === 0
          ? null
          : choices.map((label) => ({ label, description: "" })),
      });
    }

    const ownerTurn = turn ?? this.activeByLive.get(liveSessionId)?.turn ?? null;
    const clarifyTool = ownerTurn === null
      ? undefined
      : [...ownerTurn.items].reverse().find((item) => (
          item.type === "dynamicToolCall"
          && item.namespace === "hermes"
          && item.tool === "clarify"
          && item.status === "inProgress"
        ));
    const request: HermesAppServerInteractionRequest = {
      id: appServerRequestId,
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId: ownerTurn?.id ?? `hermes-turn-${threadId}-clarify`,
        itemId: clarifyTool?.id ?? `hermes-clarify-${threadId}-${hermesRequestId}`,
        questions,
        isBlocking: true,
        autoResolutionMs: null,
      },
    };
    const pending: PendingClarifyOwnership = {
      appServerRequest: request,
      hermesRequestId,
      liveSessionId,
      payload,
    };
    // One current request per runtime session, matching Desktop. A superseded
    // card cannot retain a second, invisible blocking owner.
    this.clearSessionClarify(liveSessionId);
    this.pendingClarifyByRequest.set(appServerRequestId, pending);
    for (const listener of this.serverRequestListeners) listener(request);
  }

  private expirePendingClarify(liveSessionId: string, hermesRequestId: string): void {
    for (const [requestId, pending] of this.pendingClarifyByRequest) {
      if (pending.liveSessionId !== liveSessionId || pending.hermesRequestId !== hermesRequestId) continue;
      this.pendingClarifyByRequest.delete(requestId);
      this.emit("serverRequest/resolved", {
        requestId: pending.appServerRequest.id,
        threadId: pending.appServerRequest.params.threadId,
      });
    }
    const stored = this.storedByLive.get(liveSessionId);
    const session = stored === undefined ? undefined : this.payloadByStored.get(stored);
    if (session?.pending_clarify?.request_id === hermesRequestId) delete session.pending_clarify;
  }

  private clearSessionClarify(liveSessionId: string): void {
    for (const pending of this.pendingClarifyByRequest.values()) {
      if (pending.liveSessionId === liveSessionId) this.expirePendingClarify(liveSessionId, pending.hermesRequestId);
    }
  }

  private hasPendingClarify(liveSessionId: string): boolean {
    return [...this.pendingClarifyByRequest.values()].some(pending => pending.liveSessionId === liveSessionId);
  }

  private skipPendingClarify(liveSessionId: string): void {
    for (const pending of this.pendingClarifyByRequest.values()) {
      if (pending.liveSessionId !== liveSessionId) continue;
      this.expirePendingClarify(liveSessionId, pending.hermesRequestId);
      // Desktop's skip is best effort: failure must not swallow the user's
      // follow-up. Never apply this policy to approval/secret requests.
      void this.gateway.call("clarify.respond", { request_id: pending.hermesRequestId, answer: "" }).catch(() => {});
    }
  }

  private emitQueueChanged(threadId: string): void {
    this.emit("thread/queue/changed", { threadId });
  }

  /**
   * Called only after a Thread activation response has been delivered to the
   * AppServer client. An idle restored queue is level-triggered: it must flow
   * even when reconnect swallowed the previous busy -> idle edge.
   */
  resumeQueuedSubmissions(threadId: string): void {
    const payload = this.payloadByStored.get(threadId);
    const live = this.liveByStored.get(threadId);
    const owner = live === undefined ? undefined : this.activeByLive.get(live);
    if (
      payload === undefined
      || payload.running === true
      || payload.pending_clarify !== undefined
      || (owner !== undefined && !owner.isCompleted)
    ) return;
    this.drainQueue(threadId);
  }

  private emitProjection(notifications: ReturnType<HermesTurnEventStateMachine["project"]>): void {
    for (const notification of notifications) this.emit(notification.method, notification.params);
  }

  private clearSettlementTimer(live: string): void {
    const handle = this.settlementTimerByLive.get(live);
    if (handle === undefined) return;
    this.projectionScheduler.cancel(handle);
    this.settlementTimerByLive.delete(live);
  }

  private scheduleDeferredSettlement(live: string, projection: HermesTurnEventStateMachine): void {
    this.clearSettlementTimer(live);
    const settleAtMs = projection.deferredSettlementAtMs;
    if (settleAtMs === null || projection.isCompleted) return;
    const handle = this.projectionScheduler.schedule(() => {
      this.settlementTimerByLive.delete(live);
      if (this.activeByLive.get(live) !== projection) return;
      const completedBefore = projection.isCompleted;
      this.emitProjection(projection.settleDeferredSessionInfo(this.projectionScheduler.now()));
      if (!completedBefore && projection.isCompleted) {
        const threadId = this.storedByLive.get(live);
        if (threadId !== undefined) this.drainQueue(threadId);
      }
    }, Math.max(0, settleAtMs - this.projectionScheduler.now()));
    this.settlementTimerByLive.set(live, handle);
  }

  private promotePendingProjection(live: string): HermesTurnEventStateMachine | undefined {
    const pending = this.pendingByLive.get(live);
    const next = pending?.shift();
    if (pending !== undefined && pending.length === 0) this.pendingByLive.delete(live);
    if (next !== undefined) this.activeByLive.set(live, next);
    return next;
  }

  private drainQueue(threadId: string): void {
    const entry = this.composerQueue.read(threadId)[0];
    if (
      entry === undefined
      || this.scheduledQueueDrainByStored.has(threadId)
      || entry.pausedReason !== null
    ) return;
    this.scheduledQueueDrainByStored.add(threadId);
    queueMicrotask(() => {
      this.scheduledQueueDrainByStored.delete(threadId);
      void this.startQueuedSubmission(threadId, entry.id).catch((error) => {
        if (!this.composerQueue.read(threadId).some((candidate) => candidate.id === entry.id)) {
          this.drainQueue(threadId);
          return;
        }
        // Codex never retries a failed/unknown queue admission automatically:
        // the same intent may already have crossed the transport boundary.
        this.emit("error", {
          error: { message: error instanceof Error ? error.message : String(error) },
          threadId,
        });
      });
    });
  }

  private projectGatewayEvent(event: Record<string, unknown>): void {
    const live = typeof event.session_id === "string" ? event.session_id : "";
    const threadId = this.storedByLive.get(live);
    if (threadId === undefined) return;
    const occurredAtMs = this.projectionScheduler.now();
    const eventPayload = record(event.payload);
    if (event.type === "clarify.request") {
      this.offerPendingClarify(
        live,
        threadId,
        this.activeByLive.get(live)?.turn
          ?? this.admissionByLive.get(live)?.projection.turn
          ?? null,
        eventPayload as unknown as HermesPendingClarify,
      );
    } else if (event.type === "clarify.expire" && typeof eventPayload.request_id === "string") {
      this.expirePendingClarify(live, eventPayload.request_id);
    }
    const payload = this.payloadByStored.get(threadId);
    if (payload !== undefined) {
      if (event.type === "clarify.request") {
        payload.pending_clarify = eventPayload as unknown as HermesPendingClarify;
      }
      if (event.type === "message.start") payload.running = true;
      if (event.type === "message.complete" || event.type === "error") payload.running = false;
    }
    if (event.type === "session.info" && typeof event.payload === "object" && event.payload !== null) {
      if (payload !== undefined) {
        const info = event.payload as Record<string, unknown>;
        if (typeof info.running === "boolean") payload.running = info.running;
        payload.info = {
          ...payload.info,
          ...info,
        };
      }
    }
    if (event.type === "tool.complete" && typeof eventPayload.tool_id === "string") {
      for (const pending of this.pendingClarifyByRequest.values()) {
        const ownerItem = this.activeByLive.get(live)?.turn.items.find(item => item.id === pending.appServerRequest.params.itemId);
        if (pending.liveSessionId === live && (ownerItem?.callId ?? pending.appServerRequest.params.itemId) === eventPayload.tool_id) {
          this.expirePendingClarify(live, pending.hermesRequestId);
        }
      }
    }
    if (event.type === "message.complete" || event.type === "error") {
      this.clearSessionClarify(live);
    }
    if (
      event.type === "session.info"
      && eventPayload.running === false
      && this.hasPendingClarify(live)
    ) {
      return;
    }
    const admission = this.admissionByLive.get(live);
    if (admission !== undefined) {
      admission.events.push({ event: structuredClone(event), occurredAtMs });
      return;
    }
    this.routeProjectionEvent(live, event, occurredAtMs);
  }

  private routeProjectionEvent(live: string, event: Record<string, unknown>, occurredAtMs: number): void {
    // Apply stream ownership boundaries when frames are consumed, not when
    // they are buffered awaiting admission. Replaying them must not repeat
    // cache updates or clarify side effects in projectGatewayEvent.
    if (event.type === "session.info" && record(event.payload).running === false) {
      this.queuedBoundaryPendingByLive.delete(live);
    }
    let projection = this.activeByLive.get(live);
    if (
      event.type === "message.start"
      && (projection === undefined || projection.isCompleted)
      && !this.queuedBoundaryPendingByLive.has(live)
    ) {
      this.clearSettlementTimer(live);
      projection = this.promotePendingProjection(live);
    }
    if (projection === undefined) return;
    this.projectEventIntoOwner(live, projection, event, occurredAtMs);
  }

  private projectEventIntoOwner(
    live: string,
    projection: HermesTurnEventStateMachine,
    event: Record<string, unknown>,
    occurredAtMs: number,
  ): void {
    const threadId = this.storedByLive.get(live);
    if (threadId === undefined) return;
    const completedBeforeEvent = projection.isCompleted;
    this.emitProjection(projection.project(event, occurredAtMs));
    this.scheduleDeferredSettlement(live, projection);
    if (!completedBeforeEvent && projection.isCompleted) {
      this.clearSettlementTimer(live);
      // Keep the settled owner until Draft promotion / Resume has crossed its
      // replay barrier. `startTurn` may replace it immediately for an already
      // active Conversation, so this does not block the next user command.
      this.drainQueue(threadId);
    }
  }
}
