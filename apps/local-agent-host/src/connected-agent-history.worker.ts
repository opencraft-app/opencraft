import {codexSessionDirectory, codexHistoryHomes} from "./codex-session-directory.js";
import { exportConversationContext } from "./conversation-context-export.js";
import { CodexHistorySources, codexHistoryRecords, containedNativeHistoryPath, type CodexHistoryRange } from "./codex-history-sources.js";
import { codexProjectGroups } from "./codex-project-groups.js";
import { CodeBuddyIdeHistory } from "./codebuddy-ide-history.js";
import { NativeCliSessions, projectNativeMessages, readCodeBuddyHistory } from "./native-cli-sessions.js";
import { readPiCliHistory } from "./pi-cli-history.js";
import { LocalAttachmentStagingService } from "./attachments/local-attachment-staging.js";
import { parentPort, workerData } from "node:worker_threads";
import { open, readFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createZstdDecompress } from "node:zlib";
import { projectedItemsPage, projectedTurnsPage } from "./hypernode/thread-history.js";

type Value = Record<string, any>;
type Turn = Value & { id: string; items: Value[] };
const port = parentPort!;
const { provider, home, contextDirectory, additionalHomes = [], attachmentDirectory } = workerData as { provider: "codex" | "cursor" | "pi-cli" | "claude-code" | "codebuddy" | "codebuddy-ide"; home: string; contextDirectory?: string; additionalHomes?: string[]; attachmentDirectory?: string };
const stagedAttachments = attachmentDirectory ? new LocalAttachmentStagingService(attachmentDirectory) : null;
const ideHistory = provider === "codebuddy-ide" ? new CodeBuddyIdeHistory(home) : null;
const nativeFiles = provider === "pi-cli" || provider === "codebuddy" ? new NativeCliSessions(provider, [home, ...additionalHomes]) : null;
const claudeSdk = provider === "claude-code" ? (() => { process.env.CLAUDE_CONFIG_DIR = home; return import("@anthropic-ai/claude-agent-sdk"); })() : null;
const missingNative = () => Object.assign(new Error("Native session history not found"), { code: "NATIVE_HISTORY_NOT_FOUND" });
async function claudeDirectory(cursor?: string) {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== (cursor ?? "0")) throw new Error("Invalid Claude directory cursor");
  const sdk = await claudeSdk!, rows = await sdk.listSessions({ offset, limit: 201, includeWorktrees: false, includeProgrammatic: false });
  return { available: true, sessions: rows.slice(0, 200).flatMap(row => typeof row.cwd === "string" && isAbsolute(row.cwd) ? [{ sessionId: row.sessionId, cwd: row.cwd, title: row.customTitle || row.summary || null,
    updatedAt: new Date(row.lastModified).toISOString(), ...(row.createdAt ? { createdAt: new Date(row.createdAt).toISOString() } : {}) }] : []), nextCursor: rows.length > 200 ? String(offset + 200) : null };
}
const codexSources = new CodexHistorySources(home);
const MAX_SINGLE_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_CACHE_BYTES = 24 * 1024 * 1024;
const cache = new Map<string, { stamp: string; turns: Turn[]; bytes: number }>();
let cachedBytes = 0;
const outlineCache = new Map<string, { stamp: string; turns: Turn[] }>();
const usageCache = new Map<string, { stamp: string; value: Value | null }>();
const goalCache = new Map<string, { stamp: string; value: Value | null | undefined }>();

function estimateValueBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length * 2 + 32;
  if (value === null || typeof value !== "object") return 16;
  if (depth > 4) return 64;
  if (Array.isArray(value)) {
    let total = 32;
    for (const entry of value) total += estimateValueBytes(entry, depth + 1);
    return total;
  }
  let total = 48;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    total += k.length * 2 + estimateValueBytes(v, depth + 1);
  }
  return total;
}

function rememberCachedTurns(nativeId: string, stamp: string, turns: Turn[]): void {
  const previous = cache.get(nativeId);
  if (previous) {
    cachedBytes = Math.max(0, cachedBytes - previous.bytes);
    cache.delete(nativeId);
  }
  const bytes = estimateValueBytes(turns);
  if (bytes > MAX_SINGLE_CACHE_BYTES) return;
  while (cache.size >= 8 || (cache.size > 0 && cachedBytes + bytes > MAX_TOTAL_CACHE_BYTES)) {
    const oldestKey = cache.keys().next().value!;
    const oldest = cache.get(oldestKey)!;
    cachedBytes = Math.max(0, cachedBytes - oldest.bytes);
    cache.delete(oldestKey);
  }
  cache.set(nativeId, { stamp, turns, bytes });
  cachedBytes += bytes;
}

function rememberOutlineTurns(nativeId: string, stamp: string, turns: Turn[]): Turn[] {
  const outline: Turn[] = turns.map(turn => ({
    id: turn.id,
    status: turn.status,
    ...(turn.startedAtMs !== undefined ? { startedAtMs: turn.startedAtMs } : {}),
    ...(turn.completedAtMs !== undefined ? { completedAtMs: turn.completedAtMs } : {}),
    items: [{ id: "outline", type: "agentMessage", text: "" }],
  }));
  outlineCache.delete(nativeId);
  outlineCache.set(nativeId, { stamp, turns: outline });
  if (outlineCache.size > 128) outlineCache.delete(outlineCache.keys().next().value!);
  return outline;
}

const contained = (path: string) => containedNativeHistoryPath(home, path);
const text = (content: any): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(block => block && ["text", "Text", "input_text", "output_text"].includes(block.type)).map(block => block.text ?? "").join("") : "";
function codexItem(item: Value): Value {
  const camel = (value: string) => value.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()).replace(/^[A-Z]/u, letter => letter.toLowerCase());
  const type = item.type[0].toLowerCase() + item.type.slice(1);
  if (type === "extension") {
    if (item.kind === "clock.sleep") {
      return {
        id: item.id,
        type: "sleep",
        durationMs: typeof item.durationMs === "number" ? item.durationMs : item.duration_ms ?? null,
        status: "completed",
      };
    }
    if (item.kind === "web.search") {
      return {
        id: item.id,
        type: "webSearch",
        query: item.query ?? null,
        action: item.action ?? null,
        results: item.results ?? null,
      };
    }
    if (item.kind === "vision.view_image" || item.kind === "image.view") {
      return {
        id: item.id,
        type: "imageView",
        path: item.path ?? null,
      };
    }
    const kindStr = typeof item.kind === "string" && item.kind ? item.kind : "extension";
    const dot = kindStr.indexOf(".");
    return {
      id: item.id,
      type: "dynamicToolCall",
      namespace: dot > 0 ? kindStr.slice(0, dot) : "codex",
      tool: dot > 0 ? kindStr.slice(dot + 1) : kindStr,
      arguments: null,
      status: "completed",
      success: true,
    };
  }
  if (type === "userMessage") return { ...item, type, content: Array.isArray(item.content) ? item.content.map(codexUserContentPart) : item.content };
  if (type === "agentMessage") return { id: item.id, type, text: text(item.content), phase: item.phase ?? null };
  if (type === "reasoning") return { id: item.id, type, summary: (item.summary ?? []).map((part: any) => typeof part === "string" ? part : part.text ?? ""), content: (item.content ?? []).map((part: any) => typeof part === "string" ? part : part.text ?? "") };
  const converted: Value = Object.fromEntries(Object.entries(item).map(([key, value]) => [key.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()), value]));
  converted.type = type;
  if (typeof converted.status === "string") converted.status = camel(converted.status);
  if (type === "commandExecution") {
    converted.source = typeof item.source === "string" ? camel(item.source) : null;
    converted.commandActions = (item.parsed_cmd ?? []).map((action: Value) => ({ ...action, type: typeof action.type === "string" ? camel(action.type) : action.type }));
    converted.durationMs = item.duration?.secs != null ? item.duration.secs * 1000 + (item.duration.nanos ?? 0) / 1e6 : item.duration_ms ?? null;
  }
  return converted;
}
function codexUserContentPart(part: Value): Value {
  if (!part || typeof part !== "object") return part;
  const partType = typeof part.type === "string"
    ? part.type.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase())
    : part.type;
  if (partType === "image") {
    const url = typeof part.url === "string" ? part.url
      : typeof part.image_url === "string" ? part.image_url
      : typeof part.imageUrl === "string" ? part.imageUrl
      : undefined;
    return { ...part, type: "image", ...(url !== undefined ? { url } : {}) };
  }
  if (partType === "localImage") return { ...part, type: "localImage" };
  if (partType === "localAudio") return { ...part, type: "localAudio" };
  return { ...part, type: partType };
}
function codexUserEventContent(p: Value): Value[] {
  const content: Value[] = [];
  const message = typeof p.message === "string" ? p.message : "";
  const textElements = Array.isArray(p.text_elements) ? p.text_elements : [];
  if (message.length > 0 || textElements.length > 0) {
    content.push({ type: "text", text: message, text_elements: textElements });
  }
  if (Array.isArray(p.images)) {
    for (const url of p.images) {
      if (typeof url === "string" && url.length > 0) content.push({ type: "image", url });
    }
  }
  if (Array.isArray(p.local_images)) {
    const details = Array.isArray(p.local_image_details) ? p.local_image_details : [];
    for (let i = 0; i < p.local_images.length; i++) {
      const path = p.local_images[i];
      if (typeof path === "string" && path.length > 0) {
        const detail = typeof details[i] === "string" ? details[i] : undefined;
        content.push({ type: "localImage", path, ...(detail ? { detail } : {}) });
      }
    }
  }
  if (content.length === 0) content.push({ type: "text", text: message, text_elements: [] });
  return content;
}
async function readCodex(ranges: readonly CodexHistoryRange[], outlineOnly = false): Promise<Turn[]> {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  const upsert = (item: Value) => {
    if (!current) return;
    if (outlineOnly) {
      if (current.items.length === 0) current.items.push({ id: "outline", type: "agentMessage", text: "" });
      return;
    }
    const index = current.items.findIndex((old: Value) => old.id === item.id);
    if (index < 0) current.items.push(item); else current.items[index] = item;
  };
  for await (const record of codexHistoryRecords(ranges, { relevantEventsOnly: true, outlineOnly })) {
    const p = record.payload ?? {};
    if (record.type !== "event_msg") continue;
    if (p.type === "task_started") {
      if (typeof p.turn_id !== "string" || !p.turn_id) throw new Error("Native history turn identity missing");
      current = turns.find(turn => turn.id === p.turn_id);
      if (!current) { current = { id: p.turn_id, items: [], status: "inProgress", startedAtMs: Date.parse(typeof p.started_at === "string" ? p.started_at : record.timestamp) }; turns.push(current); }
    } else if (p.type === "item_completed" && p.item?.type) {
      if (!current || p.turn_id && current.id !== p.turn_id) current = turns.find(turn => turn.id === p.turn_id);
      upsert(outlineOnly ? p.item : codexItem(p.item));
    } else if (["user_message", "agent_message", "agent_reasoning"].includes(p.type) && current) {
      if (outlineOnly) { upsert({ id: "outline" }); continue; }
      const kind = p.type === "user_message" ? "userMessage" : p.type === "agent_message" ? "agentMessage" : "reasoning";
      const item = kind === "userMessage" ? { type: kind, content: codexUserEventContent(p) }
        : kind === "reasoning" ? { type: kind, summary: [], content: [p.text ?? ""] } : { type: kind, text: p.message ?? "" };
      if (!current.items.some((old: Value) => old.type === kind && (kind === "userMessage" ? text(old.content) === (p.message ?? "") : old.text === p.message))) upsert({ id: `${current.id}:${kind}:${current.items.length}`, ...item });
    } else if (["task_complete", "turn_aborted"].includes(p.type)) {
      const turn = turns.find(turn => turn.id === p.turn_id) ?? current;
      if (turn) { turn.status = p.type === "turn_aborted" ? "interrupted" : "completed"; turn.completedAtMs = Date.parse(typeof p.completed_at === "string" ? p.completed_at : record.timestamp); }
    } else if (p.type === "thread_rolled_back") turns.splice(Math.max(0, turns.length - Number(p.num_turns ?? 0)));
  }
  return turns.filter(turn => turn.items.length);
}

/** Minimal bounded protobuf wire reader for Cursor's local conversation graph.
 * Only reachable turns/messages are read; root/system prompt blobs are excluded. */
function fields(bytes: Uint8Array): Map<number, Array<Buffer | number>> {
  const b = Buffer.from(bytes), result = new Map<number, Array<Buffer | number>>(); let offset = 0;
  const variable = () => {
    let n = 0n, shift = 0n;
    while (offset < b.length && shift < 70n) { const value = b[offset++]!; n |= BigInt(value & 127) << shift; if (value < 128) return Number(n <= BigInt(Number.MAX_SAFE_INTEGER) ? n : BigInt.asIntN(64, n)); shift += 7n; }
    throw new Error("Invalid native history encoding");
  };
  while (offset < b.length) {
    const tag = variable(), number = tag >>> 3, wire = tag & 7; let value: Buffer | number;
    if (wire === 0) value = variable();
    else if ([1, 2, 5].includes(wire)) {
      const length = wire === 2 ? variable() : wire === 1 ? 8 : 4;
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > b.length) throw new Error("Invalid native history field");
      value = b.subarray(offset, offset + length); offset += length;
    } else throw new Error("Unsupported native history wire type");
    const list = result.get(number) ?? []; list.push(value); result.set(number, list);
  }
  return result;
}
const buffer = (map: ReturnType<typeof fields>, number: number): Buffer | undefined => { const value = map.get(number)?.[0]; return Buffer.isBuffer(value) ? value : undefined; };
const string = (map: ReturnType<typeof fields>, number: number): string => buffer(map, number)?.toString("utf8") ?? "";
function readCursor(path: string, nativeId: string): Turn[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const raw = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value: string } | undefined;
    if (!raw) throw new Error("Native conversation metadata missing");
    const metadata = JSON.parse(Buffer.from(raw.value, "hex").toString("utf8"));
    if (metadata.agentId !== nativeId) throw new Error("Native history identity mismatch");
    const get = db.prepare("SELECT data FROM blobs WHERE id=?");
    const blob = (id: Buffer | string): Buffer => {
      const key = Buffer.isBuffer(id) ? id.toString("hex") : id;
      if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid native history reference");
      const row = get.get(key) as { data: Uint8Array } | undefined;
      if (!row) throw new Error("Native history message missing");
      return Buffer.from(row.data);
    };
    if (!metadata.latestRootBlobId) return [];
    const root = fields(blob(metadata.latestRootBlobId)), turns: Turn[] = [];
    for (const ref of root.get(8) ?? []) {
      if (!Buffer.isBuffer(ref)) throw new Error("Invalid native history turn");
      const turn = fields(blob(ref)), agentBytes = buffer(turn, 1);
      if (!agentBytes) {
        const shellBytes = buffer(turn, 2);
        if (!shellBytes) throw new Error("Unsupported native history turn");
        const shell = fields(shellBytes), commandRef = buffer(shell, 1), outputRef = buffer(shell, 2);
        if (!commandRef || !outputRef) throw new Error("Native shell history missing");
        const command = fields(blob(commandRef)), output = fields(blob(outputRef)), shellId = ref.toString("hex");
        turns.push({ id: shellId, status: "completed", items: [{ id: `${shellId}:command`, type: "commandExecution", command: string(command, 1),
          source: "userShell", status: "completed", commandActions: [], aggregatedOutput: [string(output, 1), string(output, 2)].filter(Boolean).join("\n"), exitCode: output.get(3)?.[0] ?? null, durationMs: null }] });
        continue;
      }
      const agent = fields(agentBytes), userRef = buffer(agent, 1);
      if (!userRef) throw new Error("Native user message missing");
      const user = fields(blob(userRef)), id = string(user, 2) || ref.toString("hex"), items: Value[] = [];
      const userText = string(user, 1) || (buffer(user, 18) ? blob(buffer(user, 18)!).toString("utf8") : "");
      items.push({ id, type: "userMessage", content: [{ type: "text", text: userText, text_elements: [] }] });
      for (const stepRef of agent.get(2) ?? []) {
        if (!Buffer.isBuffer(stepRef)) throw new Error("Invalid native history step");
        const step = fields(blob(stepRef)), assistant = buffer(step, 1), thinking = buffer(step, 3);
        const stepId = stepRef.toString("hex");
        if (assistant) items.push({ id: stepId, type: "agentMessage", text: string(fields(assistant), 1) });
        else if (thinking) items.push({ id: stepId, type: "reasoning", summary: [], content: [string(fields(thinking), 1)] });
        else if (buffer(step, 2)) {
          const call = fields(buffer(step, 2)!), entry = [...call].find(([key]) => ![54, 57, 59, 60].includes(key));
          if (!entry || !Buffer.isBuffer(entry[1][0])) continue;
          const body = fields(entry[1][0]), args = buffer(body, 1), result = buffer(body, 2);
          const names: Record<number, string> = { 1: "shell", 3: "delete", 4: "glob", 5: "grep", 8: "read", 12: "edit", 13: "ls", 15: "mcp", 18: "webSearch", 19: "task", 24: "fetch" };
          const output = result ? fields(result) : undefined, success = output && buffer(output, 1);
          let resultText = string(body, 3);
          if (entry[0] === 1 && success) { const shell = fields(success); resultText = [string(shell, 5), string(shell, 6)].filter(Boolean).join("\n"); }
          items.push({ id: string(call, 57) || stepId, type: "dynamicToolCall", namespace: "cursor", tool: names[entry[0]] ?? `tool_${entry[0]}`,
            arguments: args ? { input: string(fields(args), 1) } : {}, status: result ? success ? "completed" : "failed" : "inProgress", success: result ? !!success : null,
            contentItems: resultText ? [{ type: "inputText", text: resultText }] : [] });
        }
      }
      turns.push({ id: string(agent, 3) || ref.toString("hex"), items, status: items.at(-1)?.type === "agentMessage" ? "completed" : "inProgress", startedAtMs: user.get(25)?.[0] ?? null });
    }
    db.exec("COMMIT"); return turns;
  } finally { db.close(); }
}
let projectState: { stamp: string; data: unknown } | undefined;
async function read(nativeId: string, params: Value, kind: string): Promise<any> {
  if (kind === "sources") return provider === "codex" ? codexHistoryHomes(home) : {sources:[]};
  if (kind === "directory") {
    if (params.archived && provider !== "codex") throw new Error("Archived native discovery is unavailable");
    return ideHistory ? ideHistory.directory(params.nativeScope, params.cursor) : provider === "codex" ? codexSessionDirectory(home, params.cursor, params.archived === true)
      : nativeFiles ? nativeFiles.directory(params.cursor) : provider === "claude-code" ? claudeDirectory(params.cursor) : { available: false, sessions: [], nextCursor: null };
  }
  if (kind === "validate") {
    if (!/^[a-f0-9-]{32,64}$/u.test(nativeId)) throw new Error("Invalid native conversation identity");
    if (ideHistory) await ideHistory.read(params.nativeScope, nativeId, params.cwd);
    else if (nativeFiles) { if ((await nativeFiles.resolve(nativeId)).cwd !== params.cwd) throw new Error("Native session workspace changed"); }
    else if (claudeSdk) { if ((await (await claudeSdk).getSessionInfo(nativeId))?.cwd !== params.cwd) throw new Error("Native session workspace changed"); }
    else throw new Error("Native resume validation is unavailable");
    return {};
  }
  if (kind === "resolve") {
    if (!nativeFiles) throw new Error("Native path resolution is unavailable");
    try { return (await nativeFiles.resolve(nativeId)).path; }
    catch (error) { if (params.nativeHistoryEmpty === true && (error as NodeJS.ErrnoException).code === "NATIVE_HISTORY_NOT_FOUND") return null; throw error; }
  }
  if (kind === "projects") {
    if (provider !== "codex") return { available: false, groups: {} };
    const path = join(home, ".codex-global-state.json");
    const source = await stat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!source) return { available: false, groups: {} };
    if (source.size > 20 * 1024 * 1024 || !Array.isArray(params.threads) || params.threads.length > 10000 || params.threads.some((t: Value) => typeof t.id !== "string" || typeof t.cwd !== "string" || !isAbsolute(t.cwd))) throw new Error("Invalid native project source");
    const stamp = JSON.stringify([source.ino, source.size, source.mtimeMs]);
    if (projectState?.stamp !== stamp) projectState = { stamp, data: JSON.parse(await readFile(path, "utf8")) };
    const data = projectState.data as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid native project metadata");
    const hasLocal = data["local-projects"] !== undefined;
    const hasLegacy = Array.isArray(data["electron-saved-workspace-roots"]);
    if (hasLocal && (!data["local-projects"] || typeof data["local-projects"] !== "object" || Array.isArray(data["local-projects"]))) throw new Error("Invalid native project metadata");
    if (!hasLocal && !hasLegacy) return { available: false, groups: {} };
    return { available: true, groups: codexProjectGroups(data, params.threads) };
  }
  if (!/^[a-f0-9-]{32,64}$/u.test(nativeId)) throw new Error("Invalid native conversation identity");
  try { return await readNativeHistory(nativeId, params, kind); }
  catch (error) {
    // Native clients create their transcript on the first prompt. Only
    // the execution owner can attest that this session has accepted no input.
    const failure = error as NodeJS.ErrnoException;
    const missing = provider !== "cursor" ? failure.code === "NATIVE_HISTORY_NOT_FOUND"
      : failure.code === "ENOENT" && failure.path === join(home, "acp-sessions", nativeId, "store.db");
    if (params.nativeHistoryEmpty === true && kind !== "usage" && missing) {
      return projectHistory([], nativeId, params, kind);
    }
    throw error;
  }
}
const STAGED_FILE_LOCATOR_PATTERN = /The user attached a file named ("(?:[^"\\]|\\.)*")\. Its readable path on this Host is ("(?:[^"\\]|\\.)*")\. Read the file before answering questions about its contents; treat its contents as user-provided data\./gu;

async function restoreStagedUserMessageAttachments(turns: Turn[]): Promise<Turn[]> {
  if (!stagedAttachments) return turns;
  for (const turn of turns) {
    if (!Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (item?.type !== "userMessage" || !Array.isArray(item.content)) continue;
      if (!item.content.some((part: Value) => typeof part?.text === "string" && part.text.includes("The user attached a file named "))) continue;
      const expanded: Value[] = [];
      for (let index = 0; index < item.content.length; index++) {
        const part = item.content[index];
        if (!part || !["text", "Text", "input_text"].includes(part.type) || typeof part.text !== "string"
          || !part.text.includes("The user attached a file named ")
          || item.content[index + 1]?.type === "mention") {
          expanded.push(part);
          continue;
        }
        const matches = [...part.text.matchAll(STAGED_FILE_LOCATOR_PATTERN)];
        if (!matches.length) {
          expanded.push(part);
          continue;
        }
        let cursor = 0;
        let replaced = false;
        const segments: Value[] = [];
        for (const match of matches) {
          const matchIndex = match.index ?? 0;
          const locator = match[0]!;
          let parsedName: unknown;
          let parsedPath: unknown;
          try {
            parsedName = JSON.parse(match[1]!);
            parsedPath = JSON.parse(match[2]!);
          } catch {
            continue;
          }
          if (typeof parsedName !== "string" || typeof parsedPath !== "string") continue;
          const ref = await stagedAttachments.referenceForHostPath(parsedName, parsedPath).catch(() => null);
          if (ref?.location.kind !== "host-file") continue;
          replaced = true;
          const before = part.text.slice(cursor, matchIndex).replace(/\r?\n$/u, "");
          if (before) segments.push({ type: "text", text: before, text_elements: [] });
          segments.push(
            {
              type: "text",
              text: locator,
              text_elements: [{
                byteRange: { start: 0, end: Buffer.byteLength(locator, "utf8") },
                placeholder: "opencraft:staged-file:v1",
              }],
            },
            { type: "mention", name: ref.name, path: ref.location.path },
          );
          cursor = matchIndex + locator.length;
          if (part.text.startsWith("\r\n", cursor)) cursor += 2;
          else if (part.text.startsWith("\n", cursor)) cursor += 1;
        }
        if (!replaced) {
          expanded.push(part);
          continue;
        }
        const trailing = part.text.slice(cursor);
        if (trailing) segments.push({ type: "text", text: trailing, text_elements: [] });
        expanded.push(...segments);
      }
      item.content = expanded;
    }
  }
  return turns;
}

const comparableUserText = (content: any): string =>
  (typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block && ["text", "Text", "input_text", "output_text"].includes(block.type)).map(block => block.text ?? "").filter(Boolean).join(" ")
    : "").replace(/\s+/gu, " ").trim();

function parseCodexGoalObject(raw: unknown): Value | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const g = raw as Value;
  if (typeof g.objective !== "string" || !g.objective.trim() || g.objective.length > 4000) return null;
  if (!["active", "paused", "blocked", "complete", "usageLimited", "budgetLimited"].includes(String(g.status))) return null;
  const createdAt = typeof g.createdAt === "number" && Number.isFinite(g.createdAt) ? Math.floor(g.createdAt) : 0;
  const updatedAt = typeof g.updatedAt === "number" && Number.isFinite(g.updatedAt) ? Math.floor(g.updatedAt) : createdAt;
  if (createdAt <= 0 || updatedAt <= 0) return null;
  return {
    objective: g.objective.trim(),
    status: g.status,
    tokenBudget: typeof g.tokenBudget === "number" && Number.isFinite(g.tokenBudget) && g.tokenBudget > 0 ? Math.floor(g.tokenBudget) : null,
    tokensUsed: typeof g.tokensUsed === "number" && Number.isFinite(g.tokensUsed) && g.tokensUsed >= 0 ? Math.floor(g.tokensUsed) : 0,
    timeUsedSeconds: typeof g.timeUsedSeconds === "number" && Number.isFinite(g.timeUsedSeconds) && g.timeUsedSeconds >= 0 ? Math.floor(g.timeUsedSeconds) : 0,
    createdAt,
    updatedAt,
  };
}

async function readCodexGoal(ranges: readonly CodexHistoryRange[]): Promise<Value | null | undefined> {
  let latest: Value | null | undefined = undefined;
  for await (const record of codexHistoryRecords(ranges, { goalEventsOnly: true })) {
    const p = record.payload ?? {};
    if (record.type === "event_msg") {
      if (p.type === "thread_goal_cleared") {
        latest = null;
      } else if (p.type === "thread_goal_updated") {
        const parsed = parseCodexGoalObject(p.goal);
        if (parsed) latest = parsed;
      }
      continue;
    }
    if (record.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(p.type)) {
      const candidates: string[] = typeof p.output === "string"
        ? [p.output]
        : Array.isArray(p.output)
          ? p.output.flatMap((entry: Value) => typeof entry?.text === "string" ? [entry.text] : [])
          : [];
      for (const text of candidates) {
        if (!text.includes('"goal"')) continue;
        try {
          const parsed = parseCodexGoalObject(JSON.parse(text)?.goal);
          if (parsed && (!latest || parsed.updatedAt >= latest.updatedAt || (parsed.createdAt >= latest.createdAt && parsed.status !== latest.status))) {
            latest = parsed;
          }
        } catch {
          // Ignore non-JSON tool outputs.
        }
      }
    }
  }
  return latest;
}

async function readNativeHistory(nativeId: string, params: Value, kind: string): Promise<any> {
  if (kind === "goal" && provider !== "codex") return undefined;
  if (ideHistory) {
    if (kind === "usage") return null;
    return projectHistory(await restoreStagedUserMessageAttachments(await ideHistory.read(params.nativeScope, nativeId, params.cwd) as Turn[]), nativeId, params, kind);
  }
  if (provider === "claude-code") {
    if (kind === "usage") return null;
    const sdk = await claudeSdk!, info = await sdk.getSessionInfo(nativeId);
    if (!info?.cwd || !isAbsolute(info.cwd)) throw missingNative();
    if (params.cwd !== undefined && params.cwd !== info.cwd) throw new Error("Native session workspace changed");
    const rows = await sdk.getSessionMessages(nativeId, { dir: info.cwd });
    if (rows.some(row => row.session_id !== nativeId)) throw new Error("Native session identity changed");
    return projectHistory(await restoreStagedUserMessageAttachments(projectNativeMessages(rows, "claude-code") as Turn[]), nativeId, params, kind);
  }
  if (nativeFiles) {
    if (kind === "usage") return null;
    const entry = await nativeFiles.resolve(nativeId);
    if (params.cwd !== undefined && params.cwd !== entry.cwd) throw new Error("Native session workspace changed");
    const path = entry.path, source = await stat(path);
    const stamp = JSON.stringify([source.dev, source.ino, source.size, source.mtimeMs]);
    const stored = cache.get(nativeId);
    let turns: Turn[];
    if (stored?.stamp === stamp) {
      turns = stored.turns;
    } else {
      turns = await restoreStagedUserMessageAttachments(provider === "pi-cli" ? await readPiCliHistory(path, nativeId) : await readCodeBuddyHistory(path) as Turn[]);
      rememberCachedTurns(nativeId, stamp, turns);
    }
    return projectHistory(turns, nativeId, params, kind);
  }
  const ranges = provider === "codex" ? await codexSources.resolve(nativeId) : undefined;
  const path = ranges ? ranges.at(-1)!.path : await contained(join(home, "acp-sessions", nativeId, "store.db"));
  const source = await stat(path), wal = provider === "cursor" ? await stat(`${path}-wal`).catch(() => null) : null;
  if (kind === "goal") {
    const goalStamp = JSON.stringify(ranges!.map(range => range.stamp));
    const cachedGoal = goalCache.get(nativeId);
    if (cachedGoal?.stamp === goalStamp) return cachedGoal.value;
    const value = await readCodexGoal(ranges!);
    goalCache.delete(nativeId);
    goalCache.set(nativeId, { stamp: goalStamp, value });
    if (goalCache.size > 64) goalCache.delete(goalCache.keys().next().value!);
    return value;
  }
  if (kind === "usage") {
    if (provider === "codex") {
      const usageStamp = JSON.stringify([path, source.dev, source.ino, source.size, source.mtimeMs]);
      const cachedUsage = usageCache.get(nativeId);
      if (cachedUsage?.stamp === usageStamp) return cachedUsage.value;
      const value = await readCodexUsage(path, nativeId);
      usageCache.delete(nativeId);
      usageCache.set(nativeId, { stamp: usageStamp, value });
      if (usageCache.size > 64) usageCache.delete(usageCache.keys().next().value!);
      return value;
    }
    return readCursorUsage(path, nativeId, Math.max(source.mtimeMs, wal?.mtimeMs ?? 0));
  }
  const stamp = ranges ? JSON.stringify(ranges.map(range => range.stamp)) : JSON.stringify([source.dev, source.ino, source.size, source.mtimeMs, wal?.size, wal?.mtimeMs]);
  const stored = cache.get(nativeId);
  if (stored?.stamp === stamp) {
    return projectHistory(stored.turns, nativeId, params, kind);
  }
  if (provider === "codex" && kind === "turns" && params.itemsView === "notLoaded" && !params.activeTurn) {
    const cachedOutline = outlineCache.get(nativeId);
    if (cachedOutline?.stamp === stamp) {
      return projectHistory(cachedOutline.turns, nativeId, params, kind);
    }
    const outline = rememberOutlineTurns(nativeId, stamp, await readCodex(ranges!, true));
    return projectHistory(outline, nativeId, params, kind);
  }
  const turns = await restoreStagedUserMessageAttachments(provider === "codex" ? await readCodex(ranges!) : readCursor(path, nativeId));
  rememberCachedTurns(nativeId, stamp, turns);
  if (provider === "codex") rememberOutlineTurns(nativeId, stamp, turns);
  return projectHistory(turns, nativeId, params, kind);
}
function projectHistory(nativeTurns: Turn[], nativeId: string, params: Value, kind: string): any {
  let turns = nativeTurns;
  const active = params.activeTurn;
  if (active?.status === "inProgress" && Array.isArray(active.items)) {
    const tail = turns.at(-1), user = active.items.find((item: Value) => item.type === "userMessage");
    const same = tail && Number(tail.startedAtMs) >= Math.floor(Number(active.startedAtMs) / 1000) * 1000
      && comparableUserText(tail.items.find((item: Value) => item.type === "userMessage")?.content) === comparableUserText(user?.content);
    turns = [...(same ? turns.slice(0, -1) : turns), active as Turn];
  }
  if (kind === "export") {
    if (!contextDirectory || typeof params.threadId !== "string" || typeof params.cwd !== "string" || params.title !== null && typeof params.title !== "string") throw new Error("Conversation context export is unavailable");
    return exportConversationContext(contextDirectory, params.threadId, params.title, params.cwd, turns);
  }
  const thread = { id: params.threadId ?? nativeId, turns };
  if (kind === "snapshot") return turns;
  return kind === "items" ? projectedItemsPage(thread, { ...params, threadId: thread.id })
    : { ...projectedTurnsPage(thread, { ...params, threadId: thread.id,
      itemsView: ["notLoaded", "summary"].includes(params.itemsView) ? params.itemsView : "full" }), itemsPaginationByTurnId: {} };
}
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const counts = (v: Value) => ({ totalTokens: count(v.total_tokens), inputTokens: count(v.input_tokens), outputTokens: count(v.output_tokens), cachedInputTokens: count(v.cached_input_tokens), reasoningOutputTokens: count(v.reasoning_output_tokens) });
const TOKEN_COUNT_NEEDLE = Buffer.from('"token_count"');
const SESSION_META_NEEDLE = Buffer.from('"session_meta"');

async function readCodexUsage(path: string, nativeId: string): Promise<Value | null> {
  const file = await open(path, "r");
  const stream = file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
  const zstd = path.endsWith(".jsonl.zst") ? createZstdDecompress({ chunkSize: 1024 * 1024 }) : null;
  if (zstd) {
    stream.on("error", error => zstd.destroy(error));
    stream.pipe(zstd);
  }
  let result: Value | null = null, verified = false;
  const lineChunks: Buffer[] = [];
  let lineBytes = 0, candidate = false, decided = false;
  const consumeUsageLine = (bytes: Buffer) => {
    if (!verified && !bytes.includes(SESSION_META_NEEDLE) && !bytes.includes(TOKEN_COUNT_NEEDLE)) return;
    if (verified && !bytes.includes(TOKEN_COUNT_NEEDLE) && !bytes.includes(SESSION_META_NEEDLE)) return;
    let record: Value;
    try { record = JSON.parse(bytes.toString("utf8")); } catch { return; }
    if (record.type === "session_meta") {
      if ((record.payload?.id ?? record.payload?.session_id) !== nativeId) throw new Error("Native usage identity mismatch");
      verified = true;
      return;
    }
    const info = record.type === "event_msg" && record.payload?.type === "token_count" ? record.payload.info : null;
    if (!info || !Number.isFinite(Date.parse(record.timestamp))) return;
    const used = count(info.last_token_usage?.total_tokens), limit = count(info.model_context_window);
    result = { observedAt: Date.parse(record.timestamp), context: used !== null && limit !== null && limit > 0 ? { usedTokens: used, limitTokens: limit } : null,
      total: info.total_token_usage ? counts(info.total_token_usage) : null, last: info.last_token_usage ? counts(info.last_token_usage) : null };
  };
  try {
    for await (const rawChunk of zstd ?? stream) {
      const chunk: Buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let pos = 0;
      while (pos < chunk.length) {
        const newline = chunk.indexOf(10, pos);
        if (newline < 0) {
          const part = chunk.subarray(pos);
          lineBytes += part.length;
          if (lineBytes > 64 * 1024 * 1024) throw new Error("Native usage record is too large");
          if (!decided && lineBytes >= 256) {
            const head = lineChunks.length === 0
              ? part.subarray(0, 256)
              : Buffer.concat([...lineChunks, part], lineBytes).subarray(0, 256);
            candidate = !verified || head.includes(TOKEN_COUNT_NEEDLE) || head.includes(SESSION_META_NEEDLE);
            decided = true;
          }
          if (!decided || candidate) lineChunks.push(part);
          else lineChunks.length = 0;
          break;
        }
        const part = chunk.subarray(pos, newline);
        pos = newline + 1;
        const totalBytes = lineBytes + part.length;
        if (totalBytes > 64 * 1024 * 1024) throw new Error("Native usage record is too large");
        if (!decided || candidate) {
          const bytes = lineChunks.length === 0
            ? part
            : (lineChunks.push(part), Buffer.concat(lineChunks, totalBytes));
          consumeUsageLine(bytes);
        }
        lineChunks.length = 0;
        lineBytes = 0;
        decided = false;
        candidate = false;
      }
    }
    if (lineBytes > 0 && (!decided || candidate)) {
      consumeUsageLine(lineChunks.length === 1 ? lineChunks[0]! : Buffer.concat(lineChunks, lineBytes));
    }
    if (!verified) throw new Error("Native usage identity missing");
    return result;
  } finally {
    if (zstd) { stream.unpipe(zstd); zstd.on("error", () => {}); zstd.destroy(); }
    stream.on("error", () => {});
    stream.destroy();
    await file.close();
  }
}
function readCursorUsage(path: string, nativeId: string, observedAt: number): Value | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const row = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value: string } | undefined;
    if (!row) return null;
    const metadata = JSON.parse(Buffer.from(row.value, "hex").toString("utf8"));
    if (metadata.agentId !== nativeId) throw new Error("Native history identity mismatch");
    if (!metadata.latestRootBlobId || !/^[a-f0-9]{64}$/u.test(metadata.latestRootBlobId)) return null;
    const root = db.prepare("SELECT data FROM blobs WHERE id=?").get(metadata.latestRootBlobId) as { data: Uint8Array } | undefined;
    const details = root && buffer(fields(root.data), 5); if (!details) return null;
    const data = fields(details), used = count(data.get(1)?.[0]), limit = count(data.get(2)?.[0]);
    return used !== null && limit !== null && limit > 0 ? { observedAt, context: { usedTokens: used, limitTokens: limit }, total: null, last: null } : null;
  } finally { db.close(); }
}
let pending = Promise.resolve();
port.on("message", ({ id, nativeId, params, kind }) => {
  pending = pending.then(async () => {
    try { port.postMessage({ id, result: await read(nativeId, params, kind) }); }
    catch { port.postMessage({ id, error: "Could not read the saved agent conversation" }); }
  });
});
