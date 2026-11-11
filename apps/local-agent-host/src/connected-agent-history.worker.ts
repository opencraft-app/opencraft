import { parentPort, workerData } from "node:worker_threads";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectedItemsPage, projectedTurnsPage } from "./hypernode/thread-history.js";

type Value = Record<string, any>;
type Turn = Value & { id: string; items: Value[] };
const port = parentPort!;
const { provider, home } = workerData as { provider: "codex" | "cursor"; home: string };
const paths = new Map<string, string>();
const cache = new Map<string, { stamp: string; turns: Turn[] }>();
async function contained(path: string): Promise<string> {
  const root = await realpath(home), source = await realpath(path), child = relative(root, source);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("Native history source outside configured home");
  return source;
}
async function rollout(nativeId: string): Promise<string> {
  const known = paths.get(nativeId);
  if (known) {
    try { return await contained(known); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; paths.delete(nativeId); }
  }
  for (const directory of ["sessions", "archived_sessions"]) {
    const visit = async (path: string): Promise<string | null> => {
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) { const found = await visit(child); if (found) return found; }
        else if (entry.isFile() && entry.name.endsWith(`-${nativeId}.jsonl`)) return child;
      }
      return null;
    };
    const found = await visit(join(home, directory));
    if (found) { paths.set(nativeId, found); return contained(found); }
  }
  throw new Error("Native conversation history is unavailable");
}
const text = (content: any): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(block => block && ["text", "Text", "input_text", "output_text"].includes(block.type)).map(block => block.text ?? "").join("") : "";
function codexItem(item: Value): Value {
  const camel = (value: string) => value.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()).replace(/^[A-Z]/u, letter => letter.toLowerCase());
  const type = item.type[0].toLowerCase() + item.type.slice(1);
  if (type === "userMessage") return { ...item, type, content: item.content };
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
async function readCodex(path: string, nativeId: string): Promise<Turn[]> {
  const file = await open(path, "r"), turns: Turn[] = [];
  let current: Turn | undefined, verified = false, invalid = false;
  const upsert = (item: Value) => {
    if (!current) return;
    const index = current.items.findIndex((old: Value) => old.id === item.id);
    if (index < 0) current.items.push(item); else current.items[index] = item;
  };
  try {
    const lines = createInterface({ input: file.createReadStream({ autoClose: false }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("Native history record is too large");
      // A writer's unfinished final line is retried on the next source stamp.
      if (invalid) throw new Error("Invalid native history record");
      let record: Value; try { record = JSON.parse(line); } catch { invalid = true; continue; }
      const p = record.payload ?? {};
      if (record.type === "session_meta") { if ((p.id ?? p.session_id) !== nativeId) throw new Error("Native history identity mismatch"); verified = true; }
      if (record.type !== "event_msg") continue;
      if (p.type === "task_started") {
        if (typeof p.turn_id !== "string" || !p.turn_id) throw new Error("Native history turn identity missing");
        current = turns.find(turn => turn.id === p.turn_id);
        if (!current) { current = { id: p.turn_id, items: [], status: "inProgress", startedAtMs: Date.parse(typeof p.started_at === "string" ? p.started_at : record.timestamp) }; turns.push(current); }
      } else if (p.type === "item_completed" && p.item?.type) {
        if (!current || p.turn_id && current.id !== p.turn_id) current = turns.find(turn => turn.id === p.turn_id);
        upsert(codexItem(p.item));
      } else if (["user_message", "agent_message", "agent_reasoning"].includes(p.type) && current) {
        const kind = p.type === "user_message" ? "userMessage" : p.type === "agent_message" ? "agentMessage" : "reasoning";
        const item = kind === "userMessage" ? { type: kind, content: [{ type: "text", text: p.message ?? "", text_elements: [] }] }
          : kind === "reasoning" ? { type: kind, summary: [], content: [p.text ?? ""] } : { type: kind, text: p.message ?? "" };
        if (!current.items.some((old: Value) => old.type === kind && (kind === "userMessage" ? text(old.content) === p.message : old.text === p.message))) upsert({ id: `${current.id}:${kind}:${current.items.length}`, ...item });
      } else if (["task_complete", "turn_aborted"].includes(p.type)) {
        const turn = turns.find(turn => turn.id === p.turn_id) ?? current;
        if (turn) { turn.status = p.type === "turn_aborted" ? "interrupted" : "completed"; turn.completedAtMs = Date.parse(typeof p.completed_at === "string" ? p.completed_at : record.timestamp); }
      } else if (p.type === "thread_rolled_back") turns.splice(Math.max(0, turns.length - Number(p.num_turns ?? 0)));
    }
    if (invalid) {
      const size = (await file.stat()).size, last = Buffer.alloc(1);
      if (size && (await file.read(last, 0, 1, size - 1)).bytesRead && last[0] === 10) throw new Error("Invalid native history record");
    }
  } finally { await file.close(); }
  if (!verified) throw new Error("Native history identity missing");
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
async function read(nativeId: string, params: Value, kind: string): Promise<any> {
  if (!/^[a-f0-9-]{32,64}$/u.test(nativeId)) throw new Error("Invalid native conversation identity");
  const path = provider === "codex" ? await rollout(nativeId) : await contained(join(home, "acp-sessions", nativeId, "store.db"));
  const source = await stat(path), wal = provider === "cursor" ? await stat(`${path}-wal`).catch(() => null) : null;
  if (kind === "usage") return provider === "codex" ? readCodexUsage(path, nativeId) : readCursorUsage(path, nativeId, Math.max(source.mtimeMs, wal?.mtimeMs ?? 0));
  const stamp = JSON.stringify([source.dev, source.ino, source.size, source.mtimeMs, wal?.size, wal?.mtimeMs]);
  let stored = cache.get(nativeId);
  if (!stored || stored.stamp !== stamp) {
    stored = { stamp, turns: provider === "codex" ? await readCodex(path, nativeId) : readCursor(path, nativeId) };
    cache.set(nativeId, stored); if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  let turns = stored.turns;
  const active = params.activeTurn;
  if (active?.status === "inProgress" && Array.isArray(active.items)) {
    const tail = turns.at(-1), user = active.items.find((item: Value) => item.type === "userMessage");
    const same = tail && Number(tail.startedAtMs) >= Math.floor(Number(active.startedAtMs) / 1000) * 1000
      && text(tail.items.find((item: Value) => item.type === "userMessage")?.content) === text(user?.content);
    turns = [...(same ? turns.slice(0, -1) : turns), active as Turn];
  }
  const thread = { id: params.threadId ?? nativeId, turns };
  if (kind === "snapshot") return turns;
  return kind === "items" ? projectedItemsPage(thread, { ...params, threadId: thread.id })
    : { ...projectedTurnsPage(thread, { ...params, threadId: thread.id,
      itemsView: ["notLoaded", "summary"].includes(params.itemsView) ? params.itemsView : "full" }), itemsPaginationByTurnId: {} };
}
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const counts = (v: Value) => ({ totalTokens: count(v.total_tokens), inputTokens: count(v.input_tokens), outputTokens: count(v.output_tokens), cachedInputTokens: count(v.cached_input_tokens), reasoningOutputTokens: count(v.reasoning_output_tokens) });
async function readCodexUsage(path: string, nativeId: string): Promise<Value | null> {
  const file = await open(path, "r"); let result: Value | null = null, verified = false;
  try {
    for await (const line of createInterface({ input: file.createReadStream({ autoClose: false }), crlfDelay: Infinity })) {
      if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("Native usage record is too large");
      if (!line.includes('"token_count"') && !line.includes('"session_meta"')) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "session_meta") {
        if ((record.payload?.id ?? record.payload?.session_id) !== nativeId) throw new Error("Native usage identity mismatch");
        verified = true; continue;
      }
      const info = record.type === "event_msg" && record.payload?.type === "token_count" ? record.payload.info : null;
      if (!info || !Number.isFinite(Date.parse(record.timestamp))) continue;
      const used = count(info.last_token_usage?.total_tokens), limit = count(info.model_context_window);
      result = { observedAt: Date.parse(record.timestamp), context: used !== null && limit !== null && limit > 0 ? { usedTokens: used, limitTokens: limit } : null,
        total: info.total_token_usage ? counts(info.total_token_usage) : null, last: info.last_token_usage ? counts(info.last_token_usage) : null };
    }
    if (!verified) throw new Error("Native usage identity missing");
    return result;
  } finally { await file.close(); }
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
