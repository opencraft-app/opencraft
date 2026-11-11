import { StringDecoder } from "node:string_decoder";
import { decodeFrame, splitLines, BRIDGE_ERROR_CODES } from "@opencraft/agent-bridge-protocol";
import { CursorBridge, CursorError } from "./cursor.js";
import { pathToFileURL } from "node:url";
import type { CursorFactory } from "./types.js";
import { cursorFactory } from "./native.js";
export function runCursorStdio(factory: CursorFactory): void {
const write = (v: unknown) => { process.stdout.write(JSON.stringify(v) + "\n"); };
let serial = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const bridge = new CursorBridge({ factory, notify: (method, params) => {
  const id = `cursor-callback:${++serial}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Host callback unacknowledged")); }, 30_000);
    pending.set(id, { resolve, reject, timer }); write({ jsonrpc: "2.0", id, method, params });
  });
} });
const decoder = new StringDecoder("utf8");
let lines = { carry: "", discarding: false };
let closing = false;
async function close() {
  if (closing) return; closing = true;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("Host disconnected")); }
  pending.clear();
  await bridge.close();
}
async function handle(line: string) {
  const decoded = decodeFrame(line);
  if (decoded.kind === "error") { write({ jsonrpc: "2.0", id: null, error: decoded.error }); return; }
  const m = decoded.message;
  if (!("method" in m)) {
    const p = pending.get(String(m.id));
    if (p) { pending.delete(String(m.id)); clearTimeout(p.timer); if ("error" in m && m.error) p.reject(Error("Host rejected callback")); else p.resolve("result" in m ? m.result : {}); }
  } else if ("id" in m && !closing) {
    try { write({ jsonrpc: "2.0", id: m.id, result: await bridge.handle(m.method, m.params as Record<string, unknown>) }); }
    catch (e) { write({ jsonrpc: "2.0", id: m.id, error: { kind: e instanceof CursorError ? e.kind : "unknown-outcome",
      code: e instanceof CursorError ? e.code : BRIDGE_ERROR_CODES.unknownOutcome,
      message: e instanceof CursorError ? e.message : "Cursor SDK operation unconfirmed; no replay" } }); }
  }
}
process.stdin.on("data", (data: Buffer) => {
  const batch = splitLines(decoder.write(data), lines); lines = { carry: batch.carry, discarding: batch.discarding };
  if (batch.oversized.length) { void close().finally(() => process.exit(1)); return; }
  for (const line of batch.lines) void handle(line).catch(() => { void close().finally(() => process.exit(1)); });
});
process.stdin.once("end", () => { void close().finally(() => process.exit(0)); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close().finally(() => process.exit(0)); });

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCursorStdio(cursorFactory);
