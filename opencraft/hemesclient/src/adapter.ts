import { HermesGatewayClient } from "./hermes-client";
import type { AppServerThread, AppServerTurn, HermesMessage, HermesSessionPayload, HermesSessionSummary, QueuedSubmission } from "./types";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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
      contentBase64: Buffer.from(bytes).toString("base64"),
      filename: filenameForUrl(url, mimeType, index),
    };
  } catch (error) {
    throw new Error(`Cannot load Hermes image attachment ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function referenceValue(path: string): string {
  return /\s/u.test(path) ? `\`${path.replaceAll("`", "\\`")}\`` : path;
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

function userMessageContent(message: HermesMessage): Record<string, unknown>[] {
  const source = Array.isArray(message.content) ? message.content : [message.text ?? message.content];
  const result: Record<string, unknown>[] = [];
  const deferredPaths: string[] = [];
  let hasNativeImage = false;
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
    if (body !== "") result.push({ type: "text", text: body, text_elements: [] });
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

function itemFor(message: HermesMessage, sessionId: string, index: number) {
  const body = messageText(message);
  const address = message.row_id ?? message._row_id ?? index;
  if (message.role === "user") return { type: "userMessage", id: `hermes-${sessionId}-${address}`, clientId: null, content: userMessageContent(message) };
  if (message.role === "tool") return {
    type: "dynamicToolCall", id: `hermes-${sessionId}-${address}`, namespace: "hermes",
    tool: typeof message.name === "string" ? message.name : "tool", arguments: record(message.args),
    status: "completed", contentItems: typeof message.context === "string" ? [{ type: "inputText", text: message.context }] : null,
    success: true, durationMs: null,
  };
  return { type: "agentMessage", id: `hermes-${sessionId}-${address}`, text: body, phase: message.role === "assistant" ? null : message.role, memoryCitation: null };
}

export function mapMessages(sessionId: string, messages: HermesMessage[], running = false): AppServerTurn[] {
  const turns: AppServerTurn[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user" || turns.length === 0) {
      turns.push({
        id: `hermes-turn-${sessionId}-${message.row_id ?? message._row_id ?? index}`,
        items: [], itemsView: "full", status: "completed", error: null,
        startedAt: null, completedAt: null, durationMs: null,
      });
    }
    if (message.role === "user" || message.role === "tool" || messageText(message) !== "") turns.at(-1)!.items.push(itemFor(message, sessionId, index));
  }
  if (running && turns.length > 0) turns.at(-1)!.status = "inProgress";
  return turns;
}

function makeThread(summary: HermesSessionSummary, cwd: string, turns: AppServerTurn[] = [], running = false): AppServerThread {
  const when = timestamp(summary.started_at);
  const title = summary.title.trim() || summary.preview.trim() || "New chat";
  return {
    id: summary.id, sessionId: summary.id, extra: { hermes: { source: summary.source, messageCount: summary.message_count } },
    forkedFromId: null, parentThreadId: null, preview: title, ephemeral: false, section: null, sectionEnteredAt: null,
    projectId: null, historyMode: "paginated", modelProvider: "hermes", createdAt: when, updatedAt: when, recencyAt: when,
    status: running ? { type: "active", activeFlags: [] } : { type: "idle" }, path: null, cwd,
    cliVersion: "hemesclient/0.2.0", source: { custom: "hermes" }, canAcceptDirectInput: true, threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: title, turns,
  };
}

interface ThreadListParams { cursor?: string | null; limit?: number | null; archived?: boolean | null; searchTerm?: string | null; sortDirection?: "asc" | "desc" | null }

export class HermesAppServerAdapter {
  private readonly liveByStored = new Map<string, string>();
  private readonly payloadByStored = new Map<string, HermesSessionPayload>();
  private readonly storedByLive = new Map<string, string>();
  private readonly activeByLive = new Map<string, { turn: AppServerTurn; agentItemId: string; agentText: string; tools: Map<string, Record<string, unknown>> }>();
  private readonly queuedByStored = new Map<string, QueuedSubmission[]>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();

  constructor(private readonly gateway: HermesGatewayClient, private readonly defaultCwd: string) {
    gateway.onEvent((event) => this.projectGatewayEvent(event));
  }

  subscribeNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async listThreads(params: ThreadListParams = {}) {
    if (params.archived === true) return { data: [], nextCursor: null, backwardsCursor: null };
    const response = await this.gateway.call<{ sessions: HermesSessionSummary[] }>("session.list", { limit: 1000 });
    const query = params.searchTerm?.trim().toLocaleLowerCase();
    let rows = response.sessions.filter((row) => !query || `${row.title} ${row.preview}`.toLocaleLowerCase().includes(query));
    if (params.sortDirection === "asc") rows = rows.toReversed();
    const offset = params.cursor?.startsWith("hermes:") ? Number(params.cursor.slice(7)) || 0 : 0;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    return {
      data: rows.slice(offset, offset + limit).map((row) => makeThread(row, this.payloadByStored.get(row.id)?.info?.cwd ?? this.defaultCwd)),
      nextCursor: offset + limit < rows.length ? `hermes:${offset + limit}` : null,
      backwardsCursor: offset > 0 ? `hermes:${Math.max(0, offset - limit)}` : null,
    };
  }

  async loadThread(threadId: string, includeTurns: boolean): Promise<AppServerThread> {
    const payload = await this.resume(threadId, includeTurns);
    const list = await this.gateway.call<{ sessions: HermesSessionSummary[] }>("session.list", { limit: 1000 });
    const summary = list.sessions.find((row) => row.id === threadId) ?? {
      id: threadId, title: "New chat", preview: "", started_at: Date.now() / 1000,
      message_count: payload.message_count, source: "desktop",
    };
    const turns = includeTurns ? mapMessages(threadId, payload.messages, payload.running === true) : [];
    return makeThread(summary, payload.info?.cwd ?? this.defaultCwd, turns, payload.running === true);
  }

  async startThread(cwd?: string | null): Promise<AppServerThread> {
    const payload = await this.gateway.call<HermesSessionPayload>("session.create", { cwd: cwd ?? this.defaultCwd, source: "desktop" });
    const stored = payload.stored_session_id ?? payload.session_id;
    this.liveByStored.set(stored, payload.session_id);
    this.storedByLive.set(payload.session_id, stored);
    this.payloadByStored.set(stored, payload);
    return makeThread({ id: stored, title: "New chat", preview: "", started_at: Date.now() / 1000, message_count: 0, source: "desktop" }, payload.info?.cwd ?? cwd ?? this.defaultCwd);
  }

  async startTurn(threadId: string, input: unknown): Promise<AppServerTurn> {
    const parsed = await parseInput(input);
    if (parsed.body.trim() === "" && parsed.images.length === 0) throw new Error("Hermes input is empty");
    const live = await this.ensureLive(threadId);
    if (this.activeByLive.has(live)) throw new Error(`Hermes thread is already running: ${threadId}`);
    const turn: AppServerTurn = {
      id: `hermes-turn-${crypto.randomUUID()}`,
      items: [{ type: "userMessage", id: `hermes-user-${crypto.randomUUID()}`, clientId: null, content: parsed.content }],
      itemsView: "full", status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null,
    };
    this.activeByLive.set(live, { turn, agentItemId: `hermes-agent-${crypto.randomUUID()}`, agentText: "", tools: new Map() });
    let stagedPaths: string[] = [];
    try {
      stagedPaths = await this.stageImages(live, parsed.images);
      await this.gateway.call("prompt.submit", { session_id: live, text: parsed.body });
    } catch (error) {
      await this.rollbackImages(live, stagedPaths);
      this.activeByLive.delete(live);
      throw error;
    }
    return turn;
  }

  async steerTurn(threadId: string, expectedTurnId: string | null, input: unknown): Promise<{ turnId: string }> {
    const parsed = await parseInput(input);
    if (parsed.images.length > 0) throw new Error("Hermes session.steer accepts text only; send the image as a queued follow-up");
    if (parsed.body.trim() === "") throw new Error("Hermes steer input is empty");
    const live = await this.ensureLive(threadId);
    const active = this.activeByLive.get(live);
    if (active === undefined) throw new Error(`Hermes thread has no active turn: ${threadId}`);
    if (expectedTurnId !== null && expectedTurnId !== active.turn.id) {
      throw new Error(`Hermes active turn changed: expected ${expectedTurnId}, got ${active.turn.id}`);
    }
    const result = await this.gateway.call<{ status?: string }>("session.steer", { session_id: live, text: parsed.body });
    if (result.status === "rejected") throw new Error("Hermes rejected the active-turn steer");
    return { turnId: active.turn.id };
  }

  addQueuedSubmission(threadId: string, input: unknown, clientUserMessageId: string): QueuedSubmission {
    this.validateQueuedInput(input);
    const submission: QueuedSubmission = {
      id: `hermes-queue-${crypto.randomUUID()}`,
      input: Array.isArray(input) ? structuredClone(input) : [],
      clientUserMessageId,
    };
    const queue = this.queuedByStored.get(threadId) ?? [];
    queue.push(submission);
    this.queuedByStored.set(threadId, queue);
    this.emitQueueChanged(threadId);
    return structuredClone(submission);
  }

  listQueuedSubmissions(threadId: string, cursor: string | null, limit: number | null) {
    const queue = this.queuedByStored.get(threadId) ?? [];
    const offset = cursor?.startsWith("hermes-queue:") ? Number(cursor.slice(13)) || 0 : 0;
    const size = Math.min(Math.max(limit ?? 50, 1), 200);
    return {
      data: structuredClone(queue.slice(offset, offset + size)),
      nextCursor: offset + size < queue.length ? `hermes-queue:${offset + size}` : null,
    };
  }

  updateQueuedSubmission(threadId: string, queuedSubmissionId: string, input: unknown): QueuedSubmission {
    this.validateQueuedInput(input);
    const queue = this.queuedByStored.get(threadId) ?? [];
    const index = queue.findIndex((item) => item.id === queuedSubmissionId);
    if (index < 0) throw new Error(`Hermes queued submission not found: ${queuedSubmissionId}`);
    const updated = { ...queue[index]!, input: Array.isArray(input) ? structuredClone(input) : [] };
    queue[index] = updated;
    this.emitQueueChanged(threadId);
    return structuredClone(updated);
  }

  deleteQueuedSubmission(threadId: string, queuedSubmissionId: string): boolean {
    const queue = this.queuedByStored.get(threadId) ?? [];
    const index = queue.findIndex((item) => item.id === queuedSubmissionId);
    if (index < 0) return false;
    queue.splice(index, 1);
    this.emitQueueChanged(threadId);
    return true;
  }

  reorderQueuedSubmissions(threadId: string, queuedSubmissionIds: string[]): void {
    const queue = this.queuedByStored.get(threadId) ?? [];
    if (queuedSubmissionIds.length !== queue.length || new Set(queuedSubmissionIds).size !== queue.length) {
      throw new Error("queuedSubmissionIds must contain every queued submission exactly once");
    }
    const byId = new Map(queue.map((item) => [item.id, item]));
    const reordered = queuedSubmissionIds.map((id) => {
      const item = byId.get(id);
      if (item === undefined) throw new Error(`Hermes queued submission not found: ${id}`);
      return item;
    });
    this.queuedByStored.set(threadId, reordered);
    this.emitQueueChanged(threadId);
  }

  async startQueuedSubmission(threadId: string, queuedSubmissionId?: string | null): Promise<AppServerTurn> {
    const live = await this.ensureLive(threadId);
    if (this.activeByLive.has(live)) throw new Error(`Hermes thread is already running: ${threadId}`);
    const queue = this.queuedByStored.get(threadId) ?? [];
    const index = queuedSubmissionId == null ? 0 : queue.findIndex((item) => item.id === queuedSubmissionId);
    if (index < 0 || queue[index] === undefined) throw new Error("Hermes queue is empty or the submission no longer exists");
    const [submission] = queue.splice(index, 1);
    this.emitQueueChanged(threadId);
    try {
      return await this.startTurn(threadId, submission!.input);
    } catch (error) {
      queue.splice(index, 0, submission!);
      this.emitQueueChanged(threadId);
      throw error;
    }
  }

  async cancelTurn(threadId: string): Promise<void> {
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

  private async ensureLive(storedId: string): Promise<string> {
    return this.liveByStored.get(storedId) ?? (await this.resume(storedId, false)).session_id;
  }

  private async resume(storedId: string, includeMessages: boolean): Promise<HermesSessionPayload> {
    let payload = this.payloadByStored.get(storedId);
    if (payload === undefined) {
      payload = await this.gateway.call<HermesSessionPayload>("session.resume", { session_id: storedId, omit_messages: !includeMessages });
      this.liveByStored.set(storedId, payload.session_id);
      this.storedByLive.set(payload.session_id, storedId);
      this.payloadByStored.set(storedId, payload);
    }
    if (includeMessages) {
      const history = await this.gateway.call<{ count: number; messages: HermesMessage[] }>("session.history", { session_id: payload.session_id });
      payload = { ...payload, message_count: history.count, messages: history.messages };
      this.payloadByStored.set(storedId, payload);
    }
    return payload;
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener(method, params);
  }

  private emitQueueChanged(threadId: string): void {
    this.emit("thread/queue/changed", { threadId });
  }

  private drainQueue(threadId: string): void {
    if ((this.queuedByStored.get(threadId)?.length ?? 0) === 0) return;
    queueMicrotask(() => {
      void this.startQueuedSubmission(threadId).catch((error) => {
        this.emit("error", {
          error: { message: error instanceof Error ? error.message : String(error) },
          threadId,
        });
      });
    });
  }

  private projectGatewayEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "";
    const live = typeof event.session_id === "string" ? event.session_id : "";
    const threadId = this.storedByLive.get(live);
    if (threadId === undefined) return;
    const state = this.activeByLive.get(live);
    const payload = record(event.payload);
    if (state === undefined) return;
    if (type === "message.start") {
      this.emit("turn/started", { threadId, turn: state.turn });
      const item = { type: "agentMessage", id: state.agentItemId, text: "", phase: null, memoryCitation: null };
      this.emit("item/started", { threadId, turnId: state.turn.id, item, startedAtMs: Date.now() });
      return;
    }
    if (type === "message.delta") {
      const delta = typeof payload.text === "string" ? payload.text : "";
      state.agentText += delta;
      if (delta !== "") this.emit("item/agentMessage/delta", { threadId, turnId: state.turn.id, itemId: state.agentItemId, delta });
      return;
    }
    if (type === "tool.start") {
      const id = typeof payload.tool_id === "string" && payload.tool_id ? payload.tool_id : `hermes-tool-${crypto.randomUUID()}`;
      const item = { type: "dynamicToolCall", id, namespace: "hermes", tool: typeof payload.name === "string" ? payload.name : "tool", arguments: record(payload.args), status: "inProgress", contentItems: null, success: null, durationMs: null };
      state.tools.set(id, item);
      this.emit("item/started", { threadId, turnId: state.turn.id, item, startedAtMs: Date.now() });
      return;
    }
    if (type === "tool.complete") {
      const id = typeof payload.tool_id === "string" ? payload.tool_id : "";
      const previous = state.tools.get(id) ?? {};
      const failed = record(payload.result).error !== undefined;
      const item = { ...previous, type: "dynamicToolCall", id, namespace: "hermes", tool: typeof payload.name === "string" ? payload.name : "tool", arguments: record(payload.args), status: failed ? "failed" : "completed", contentItems: payload.result === undefined ? null : [{ type: "inputText", text: typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result) }], success: !failed, durationMs: typeof payload.duration_s === "number" ? Math.round(payload.duration_s * 1000) : null };
      this.emit("item/completed", { threadId, turnId: state.turn.id, item });
      return;
    }
    if (type === "message.complete") {
      const finalText = typeof payload.text === "string" ? payload.text : state.agentText;
      const item = { type: "agentMessage", id: state.agentItemId, text: finalText, phase: null, memoryCitation: null };
      this.emit("item/completed", { threadId, turnId: state.turn.id, item });
      const status = payload.status === "interrupted" ? "interrupted" : payload.status === "error" ? "failed" : "completed";
      const now = Math.floor(Date.now() / 1000);
      const turn = { ...state.turn, items: [...state.turn.items, item], status, completedAt: now, durationMs: state.turn.startedAt === null ? null : (now - state.turn.startedAt) * 1000, error: status === "failed" ? { message: String(payload.error ?? "Hermes turn failed") } : null };
      this.emit("turn/completed", { threadId, turn });
      this.activeByLive.delete(live);
      this.drainQueue(threadId);
    }
  }
}
