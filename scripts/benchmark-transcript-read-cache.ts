import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { TranscriptReadCache } from "@opencraft/native-history-node";
import type { AppServerTurn } from "@opencraft/appserver-protocol";

// Synthetic native boundary; cache, Session, Runtime and renderer remain real.
// Pair this endpoint with benchmark-session-loading-browser.ts.
const root = await mkdtemp(join(tmpdir(), "opencraft-transcript-benchmark-"));
const home = join(root, "native"), path = join(home, "rollout.jsonl");
await mkdir(home);
const count = Number(process.env.OPENCRAFT_BENCHMARK_TURNS ?? 601);
const turns: AppServerTurn[] = Array.from({ length: count }, (_, n) => ({ id: `turn-${n}`, status: "completed", items: [
  { id: `user-${n}`, type: "userMessage", content: [{ type: "text", text: `Question ${n}` }] },
  { id: `command-${n}`, type: "commandExecution", command: "build", status: "completed", aggregatedOutput: "Build output.\n".repeat(4800), exitCode: 0 },
  { id: `agent-${n}`, type: "agentMessage", text: `Answer ${n}. Historical conversation remains available.` },
] }));
await writeFile(path, turns.map(turn => JSON.stringify({ type: "turn_context", payload: { turn_id: turn.id, output: turn.items[1]!.aggregatedOutput } }) + "\n").join(""));
const thread = { id: "benchmark-history", turns: [], path, cwd: root, historyMode: "paginated" as const, model: "fixture", modelProvider: "fixture" };
const measurements: unknown[] = [], calls: Record<string, number> = {};
const cache = new TranscriptReadCache(root, { nativeHome: home, readThread: async () => thread,
  listTurns: async (_id, cursor, limit) => { const offset = Number(cursor ?? 0); return {
    data: turns.slice().reverse().slice(offset, offset + limit), nextCursor: offset + limit < turns.length ? String(offset + limit) : null,
  }; },
}, { measured: metric => measurements.push(metric) });
const server = new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.OPENCRAFT_BENCHMARK_PORT ?? 18084) });
server.on("connection", socket => socket.on("message", async raw => {
  const frame = JSON.parse(String(raw)); if (frame.id === undefined) return;
  calls[frame.method] = (calls[frame.method] ?? 0) + 1;
  try {
    let result: unknown;
    switch (frame.method) {
      case "initialize": result = { capabilities: { extensions: { "opencraft/read-history": { version: 1, initialTurnsPage: true } } } }; break;
      case "thread/read": result = await cache.read(frame.params.threadId, 10); break;
      case "thread/turns/list": result = await cache.page(frame.params.threadId, frame.params.cursor ?? null, frame.params.limit ?? 10); break;
      case "thread/goal/get": result = { goal: null }; break;
      case "thread/queue/list": result = { data: [], nextCursor: null }; break;
      default: throw new Error("Benchmark does not permit " + frame.method);
    }
    socket.send(JSON.stringify({ id: frame.id, result }));
  } catch (error) { socket.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: String(error) } })); }
}));
await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
console.log(JSON.stringify({ port: (server.address() as { port: number }).port, threadId: thread.id, turns: count }));
async function close() {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await cache.close();
  console.log(JSON.stringify({ calls, measurements }));
  await rm(root, { recursive: true, force: true });
}
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
