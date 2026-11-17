import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { containedNativeHistoryPath } from "./codex-history-sources.js";

type Value = Record<string, any>;
type Entry = { sessionId: string; cwd: string; title: string | null; updatedAt: string; createdAt?: string; path: string };
export type FileAgent = "pi-cli" | "codebuddy";
const identity = /^[a-f0-9-]{32,64}$/u;
const missing = () => Object.assign(new Error("Native session history not found"), { code: "NATIVE_HISTORY_NOT_FOUND" });
const label = (value: unknown) => typeof value === "string" && value.trim() ? value.replace(/\s+/gu, " ").trim().slice(0, 256) : null;
const timestamp = (value: unknown) => typeof value === "number" || typeof value === "string" ? new Date(value).getTime() : NaN;

/** Worker-only discovery. Native files remain the only transcript authority. */
export class NativeCliSessions {
  private readonly locations = new Map<string, { root: string; path: string }>();
  constructor(private readonly provider: FileAgent, private readonly roots: readonly string[]) {}
  private async files(root: string, includeLinks = false): Promise<string[]> {
    const list = (path: string) => readdir(path, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const entries = await list(root), files: string[] = [];
    for (const entry of entries) {
      if ((entry.isFile() || includeLinks && entry.isSymbolicLink()) && entry.name.endsWith(".jsonl")) files.push(join(root, entry.name));
      if (entry.isDirectory()) for (const file of await list(join(root, entry.name))) {
        // Do not descend into subagent transcripts or follow directory symlinks.
        if ((file.isFile() || includeLinks && file.isSymbolicLink()) && file.name.endsWith(".jsonl")) files.push(join(root, entry.name, file.name));
      }
    }
    return files;
  }
  private async metadata(root: string, candidate: string, listing = false): Promise<Entry | null> {
    const fileId = basename(candidate, ".jsonl").split("_").at(-1)!;
    if (!identity.test(fileId)) return null;
    const path = await containedNativeHistoryPath(root, candidate), info = await stat(path);
    if (!info.isFile()) return null;
    const handle = await open(path, "r"); let head: string, tail: string;
    try {
      const prefix = Buffer.alloc(Math.min(info.size, 64 * 1024)); await handle.read(prefix, 0, prefix.length, 0); head = prefix.toString("utf8");
      const suffix = Buffer.alloc(Math.min(info.size, 64 * 1024)); await handle.read(suffix, 0, suffix.length, info.size - suffix.length); tail = suffix.toString("utf8");
    } finally { await handle.close(); }
    const parse = (raw: string) => raw.split("\n").slice(0, -1).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const first = parse(head), last = parse(tail), header = first[0];
    let cwd: unknown, title: string | null = null, created: number;
    if (this.provider === "pi-cli") {
      if (header?.type !== "session" || header.id !== fileId || ![2, 3].includes(header.version)) return null;
      // Native model discovery can persist an empty session. It is resumable,
      // but has no conversation to offer in an import directory.
      if (listing && info.size <= 64 * 1024 && !first.some(row => row.type === "message" && row.message?.role === "user")) return null;
      cwd = header.cwd; created = timestamp(header.timestamp);
      title = label(last.filter(row => row.type === "session_info").at(-1)?.name);
      if (!title) title = label(first.find(row => row.type === "message" && row.message?.role === "user")?.message?.content?.filter?.((part: Value) => part.type === "text").map((part: Value) => part.text).join(" "));
    } else {
      const meta = [...first, ...last].find(row => row.type === "session-meta");
      if (meta?.sessionId && meta.sessionId !== fileId && meta.storeId !== fileId) return null;
      cwd = first.find(row => typeof row.cwd === "string")?.cwd; created = timestamp(first.find(row => row.timestamp)?.timestamp);
      title = label(last.filter(row => row.type === "custom-title").at(-1)?.customTitle);
      if (!title) title = label(first.find(row => row.type === "message" && row.role === "user")?.content?.filter?.((part: Value) => part.type === "input_text").map((part: Value) => part.text).join(" "));
      if (!first.some(row => row.type === "message" || row.type === "session-meta")) return null;
    }
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
    return { sessionId: fileId, cwd, title, path, updatedAt: new Date(info.mtimeMs).toISOString(), ...(Number.isFinite(created) ? { createdAt: new Date(created).toISOString() } : {}) };
  }
  private async entries(): Promise<Entry[]> {
    const entries: Entry[] = [], paths = new Set<string>();
    for (const root of this.roots) for (const file of await this.files(root)) {
      const entry = await this.metadata(root, file, true).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (entry && !paths.has(entry.path)) { entries.push(entry); paths.add(entry.path); }
    }
    this.locations.clear();
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
    for (const entry of entries) {
      if (counts.get(entry.sessionId)! > 1) continue;
      const root = this.roots.find(root => entry.path.startsWith(root + sep));
      if (root) this.locations.set(entry.sessionId, { root, path: entry.path });
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sessionId.localeCompare(a.sessionId));
  }
  async resolve(id: string): Promise<Entry> {
    if (!identity.test(id)) throw new Error("Invalid native session identity");
    const known = this.locations.get(id);
    if (known) { const entry = await this.metadata(known.root, known.path); if (entry?.sessionId === id) return entry; throw new Error("Invalid native session source"); }
    const entries: Entry[] = [], paths = new Set<string>();
    for (const root of this.roots) for (const file of await this.files(root, true)) {
      if (basename(file, ".jsonl").split("_").at(-1) !== id) continue;
      const entry = await this.metadata(root, file);
      if (!entry) throw new Error("Invalid native session source");
      if (!paths.has(entry.path)) { entries.push(entry); paths.add(entry.path); }
    }
    if (entries.length > 1) throw new Error("Ambiguous native session identity");
    if (!entries.length) throw missing();
    return entries[0]!;
  }
  async directory(cursor?: string) {
    let boundary: { at: string; id: string } | undefined;
    if (cursor) { boundary = JSON.parse(Buffer.from(cursor, "base64url").toString()); if (!boundary || typeof boundary.at !== "string" || !Number.isFinite(Date.parse(boundary.at)) || !identity.test(boundary.id)) throw new Error("Invalid native directory cursor"); }
    const entries = (await this.entries()).filter(entry => !boundary || entry.updatedAt < boundary.at || entry.updatedAt === boundary.at && entry.sessionId < boundary.id);
    const page = entries.slice(0, 200), last = page.at(-1);
    return { available: true, sessions: page.map(({ path, ...entry }) => entry), nextCursor: entries.length > 200 && last ? Buffer.from(JSON.stringify({ at: last.updatedAt, id: last.sessionId })).toString("base64url") : null };
  }
}

/** Converts public Claude SDK messages and CodeBuddy's native response items. */
export function projectNativeMessages(messages: Value[], provider: "claude-code" | "codebuddy"): Value[] {
  const turns: Value[] = [], tools = new Map<string, Value>(); let turn: Value | undefined;
  const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => ["text", "input_text", "output_text"].includes(p?.type)).map(p => p.text ?? "").join("\n") : content == null ? "" : JSON.stringify(content);
  for (const row of messages) {
    if (row.parent_tool_use_id != null || row.parent_agent_id != null) continue;
    const message = provider === "claude-code" ? row.message : row;
    if (!message || typeof message !== "object") continue;
    const id = row.uuid ?? row.id; if (typeof id !== "string") continue;
    const content = message.content, parts: Value[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const user = message.role === "user" || row.type === "user";
    const userContent = parts.flatMap<Value>((part: Value) => ["text", "input_text"].includes(part.type) ? [{ type: "text", text: part.text, text_elements: [] }]
      : part.type === "image" && part.source?.type === "base64" ? [{ type: "image", url: `data:${part.source.media_type};base64,${part.source.data}` }]
      : part.type === "input_image" && typeof part.image === "string" && part.image.startsWith("data:") ? [{ type: "image", url: part.image }] : []);
    const data = row.providerData ?? {};
    if (user && userContent.length && !data.skipRun && !data.isCompactInternal && !data.isSummary && !data.isCompacted && !data.teammateMessage) {
      turn = { id, items: [{ id, type: "userMessage", content: userContent }], status: "completed", startedAtMs: Number.isFinite(timestamp(row.timestamp)) ? timestamp(row.timestamp) : null }; turns.push(turn);
    }
    if (!turn) continue;
    if (message.role === "assistant" || row.type === "assistant") for (const [index, part] of parts.entries()) {
      if (["text", "output_text"].includes(part.type)) turn.items.push({ id: `${id}:${index}`, type: "agentMessage", text: part.text });
      if (part.type === "thinking") turn.items.push({ id: `${id}:${index}`, type: "reasoning", summary: [], content: [part.thinking ?? ""] });
      if (part.type === "tool_use") { const tool = { id: part.id, type: "mcpToolCall", server: provider, tool: part.name, arguments: part.input, status: "inProgress", result: null, error: null }; tools.set(part.id, tool); turn.items.push(tool); }
    }
    for (const part of parts) if (part.type === "tool_result") { const tool = tools.get(part.tool_use_id); if (tool) { tool.status = part.is_error ? "failed" : "completed"; tool.result = { content: [{ type: "text", text: text(part.content) }] }; } }
    if (row.type === "function_call") { const key = row.call_id ?? row.callId ?? id; const tool = { id: key, type: "mcpToolCall", server: provider, tool: row.name, arguments: row.arguments, status: "inProgress", result: null, error: null }; tools.set(key, tool); turn.items.push(tool); }
    if (["function_call_result", "function_call_output"].includes(row.type)) { const tool = tools.get(row.call_id ?? row.callId ?? id); if (tool) { tool.status = row.status === "failed" || data.toolResult?.error ? "failed" : "completed"; tool.result = { content: [{ type: "text", text: text(row.output) }] }; } }
    if (row.type === "reasoning") turn.items.push({ id, type: "reasoning", summary: [], content: [text(row.content ?? row.summary)] });
    if (data.turnAborted) turn.status = "interrupted";
  }
  return turns;
}

export async function readCodeBuddyHistory(path: string): Promise<Value[]> {
  const raw = await readFile(path, "utf8");
  const rows: Value[] = raw.split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
  const blobRoot = join(dirname(dirname(dirname(path))), "blobs");
  for (const row of rows) if (row.role === "user" && Array.isArray(row.content)) {
    for (let index = 0; index < row.content.length; index++) {
      const part = row.content[index];
      if (part?.type !== "image_blob_ref") continue;
      if (!/^[a-f0-9]{64}$/u.test(part.blob_id) || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mime) || typeof part.blob_path !== "string") throw new Error("Invalid native image reference");
      const file = await containedNativeHistoryPath(blobRoot, part.blob_path), info = await stat(file);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("Native image is too large");
      const bytes = await readFile(file);
      if (bytes.length > 20 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== part.blob_id) throw new Error("Native image identity changed");
      row.content[index] = { type: "input_image", image: `data:${part.mime};base64,${bytes.toString("base64")}` };
    }
  }
  // Native append history links identify the active branch after rewinds.
  const messages = rows.filter(row => ["message", "function_call", "function_call_result", "function_call_output", "reasoning"].includes(row.type));
  if (new Set(messages.map(row => row.id)).size !== messages.length) throw new Error("Duplicate native message identity");
  const records = new Map(rows.filter(row => typeof row.id === "string").map(row => [row.id, row]));
  const last = messages.at(-1);
  if (last && Object.hasOwn(last, "parentId")) {
    const branch: Value[] = [], seen = new Set<string>(); let current: Value | undefined = last;
    while (current) { if (seen.has(current.id)) throw new Error("Cyclic native history"); seen.add(current.id); branch.push(current); if (current.parentId == null) break; current = records.get(current.parentId); if (!current) throw new Error("Native history parent is missing"); }
    return projectNativeMessages(branch.reverse(), "codebuddy");
  }
  return projectNativeMessages(messages, "codebuddy");
}
