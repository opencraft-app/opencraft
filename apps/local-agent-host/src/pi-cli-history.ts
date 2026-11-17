import { readFile } from "node:fs/promises";

type Value = Record<string, any>;
type Turn = Value & { id: string; items: Value[] };
const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n") : "";

/** Invoked only in the existing native-history Worker. Pi remains the JSONL writer. */
export async function readPiCliHistory(path: string, nativeId: string): Promise<Turn[]> {
  const raw = await readFile(path, "utf8"), lines = raw.split("\n");
  lines.pop(); // A final unterminated record is not yet committed by the JSONL writer.
  const entries = lines.map(line => JSON.parse(line));
  const header = entries.shift();
  if (header?.type !== "session" || header.id !== nativeId || ![2, 3].includes(header.version)) throw new Error("Invalid Pi session source");
  const records = new Map<string, Value>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || records.has(entry.id) || entry.parentId !== null && typeof entry.parentId !== "string") throw new Error("Invalid Pi session graph");
    records.set(entry.id, entry);
  }
  const branch: Value[] = [], seen = new Set<string>();
  let current: Value | undefined = entries.at(-1);
  while (current) {
    if (seen.has(current.id)) throw new Error("Cyclic Pi session graph");
    seen.add(current.id); branch.push(current);
    if (current.parentId === null) break;
    current = records.get(current.parentId);
    if (!current) throw new Error("Pi session parent is missing");
  }
  const turns: Turn[] = []; let turn: Turn | undefined;
  const tools = new Map<string, Value>();
  for (const entry of branch.reverse()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message.role !== "string") throw new Error("Invalid Pi message");
    if (message.role === "user") {
      turn = { id: entry.id, status: "completed", startedAtMs: message.timestamp ?? Date.parse(entry.timestamp), items: [] }; turns.push(turn);
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content, text_elements: [] }]
        : Array.isArray(message.content) ? message.content.flatMap((part: Value) => part.type === "text" ? [{ type: "text", text: part.text, text_elements: [] }]
          : part.type === "image" ? [{ type: "image", url: `data:${part.mimeType};base64,${part.data}` }] : []) : [];
      turn.items.push({ id: entry.id, type: "userMessage", content });
    } else if (message.role === "assistant" && turn) {
      for (const [index, part] of (Array.isArray(message.content) ? message.content : []).entries()) {
        const id = `${entry.id}:${index}`;
        if (part.type === "text") turn.items.push({ id, type: "agentMessage", text: part.text });
        else if (part.type === "thinking") turn.items.push({ id, type: "reasoning", summary: [], content: [part.thinking ?? ""] });
        else if (part.type === "toolCall") {
          const tool = { id: part.id, type: "mcpToolCall", server: "pi", tool: part.name, arguments: part.arguments, status: "inProgress", result: null, error: null };
          tools.set(part.id, tool); turn.items.push(tool);
        }
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") turn.status = message.stopReason === "aborted" ? "interrupted" : "failed";
    } else if (message.role === "toolResult" && turn) {
      const tool = tools.get(message.toolCallId);
      if (tool) { tool.status = message.isError ? "failed" : "completed"; tool.result = { content: [{ type: "text", text: text(message.content) }] }; }
    }
  }
  return turns;
}
