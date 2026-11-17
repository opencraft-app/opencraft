import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { containedNativeHistoryPath } from "./codex-history-sources.js";
import { projectNativeMessages } from "./native-cli-sessions.js";

type Value = Record<string, any>;
const identity = /^[a-f0-9-]{32,64}$/u;
const missing = () => Object.assign(new Error("Native IDE history not found"), { code: "NATIVE_HISTORY_NOT_FOUND" });
/** Worker-only reader, scoped by the authenticated IDE connection, never the browser. */
export class CodeBuddyIdeHistory {
  constructor(private readonly home: string) {}
  private async json(path: string): Promise<Value> {
    const safe = await containedNativeHistoryPath(this.home, path), info = await stat(safe);
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("Native IDE record is too large");
    return JSON.parse(await readFile(safe, "utf8"));
  }
  private async source(scope: Value) {
    if (!scope || typeof scope.userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(scope.userId) || typeof scope.cwd !== "string" || !isAbsolute(scope.cwd)) throw new Error("Connect the signed-in IDE project before reading history");
    const account = join(this.home, scope.userId), hash = createHash("md5").update(normalize(scope.cwd)).digest("hex");
    const types = await readdir(account, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const sources: { path: string; data: Value }[] = [];
    for (const type of types.filter(entry => entry.isDirectory())) {
      const path = join(account, type.name, scope.userId, "history", hash);
      const data = await this.json(join(path, "index.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (data) { if (!Array.isArray(data.conversations)) throw new Error("Unsupported native IDE directory"); sources.push({ path, data }); }
    }
    const active = scope.currentSessionId ? sources.filter(source => source.data.conversations.some((entry: Value) => entry.id === scope.currentSessionId)) : [];
    const choices = active.length ? active : sources;
    if (choices.length > 1) throw new Error("Native IDE history source is ambiguous");
    return choices[0];
  }
  async directory(scope: Value, cursor?: string) {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== (cursor ?? "0")) throw new Error("Invalid IDE directory cursor");
    const source = await this.source(scope);
    const rows = (source?.data.conversations ?? []).filter((entry: Value) => identity.test(entry.id) && !entry.hidden && !entry.isDeleted)
      .sort((a: Value, b: Value) => String(b.lastMessageAt ?? b.createdAt).localeCompare(String(a.lastMessageAt ?? a.createdAt)) || b.id.localeCompare(a.id));
    return { available: true, sessions: rows.slice(offset, offset + 200).map((entry: Value) => ({ sessionId: entry.id, cwd: scope.cwd,
      title: typeof entry.name === "string" ? entry.name.slice(0, 256) : null, updatedAt: entry.lastMessageAt ?? entry.createdAt ?? null,
      ...(typeof entry.createdAt === "string" ? { createdAt: entry.createdAt } : {}) })), nextCursor: rows.length > offset + 200 ? String(offset + 200) : null };
  }
  async read(scope: Value, id: string, cwd?: string) {
    if (!identity.test(id) || cwd !== undefined && cwd !== scope.cwd) throw new Error("Return to the original IDE project before continuing");
    const source = await this.source(scope);
    if (!source?.data.conversations.some((entry: Value) => entry.id === id)) throw missing();
    const path = join(source.path, id), index = await this.json(join(path, "index.json"));
    if (!Array.isArray(index.messages) || !Array.isArray(index.requests)) throw new Error("Unsupported IDE conversation index");
    const messages: Value[] = [];
    for (const ref of index.messages) {
      if (typeof ref?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(ref.id)) throw new Error("Invalid IDE message identity");
      const row = await this.json(join(path, "messages", `${ref.id}.json`));
      if (row.id !== ref.id) throw new Error("IDE message identity changed");
      const raw = typeof row.message === "string" ? JSON.parse(row.message) : row.message;
      if (!raw || typeof raw !== "object") throw new Error("Unsupported IDE message");
      const content = typeof raw.content === "string" ? [{ type: "text", text: raw.content }] : raw.content;
      if (!Array.isArray(content)) throw new Error("Unsupported IDE message content");
      const parts = content.map((part: Value) => part.type === "tool-call" ? { type: "tool_use", id: part.toolCallId, name: part.toolName, input: part.args ?? part.input }
        : part.type === "tool-result" ? { type: "tool_result", tool_use_id: part.toolCallId, content: typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? part.output), is_error: part.isError === true }
        : part.type === "reasoning" ? { type: "thinking", thinking: part.text } : part);
      messages.push({ uuid: row.id, timestamp: row.createdAt ?? row.createTime, message: { role: row.role ?? raw.role, content: parts } });
    }
    return projectNativeMessages(messages, "claude-code");
  }
}
