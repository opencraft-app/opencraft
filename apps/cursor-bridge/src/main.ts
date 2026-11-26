import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { decodeFrame, splitLines, BRIDGE_ERROR_CODES } from "@opencraft/agent-bridge-protocol";
import { CursorBridge, CursorError } from "./cursor.js";
import { cursorFactory } from "./native.js";
import type { CursorFactory } from "./types.js";

const STDIO_SHUTDOWN_GRACE_MS = 10_000;

export function runCursorStdio(factory: CursorFactory): void {
  let closing = false;
  let serial = 0;
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const write = (frame: unknown) => {
    if (!closing) process.stdout.write(JSON.stringify(frame) + "\n");
  };
  const bridge = new CursorBridge({
    factory,
    notify(method, params) {
      if (closing) return Promise.reject(Error("Host disconnected"));
      const id = `cursor-callback:${++serial}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Host callback unacknowledged"));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
  });
  const decoder = new StringDecoder("utf8");
  let lines = { carry: "", carryBytes: 0, discarding: false };

  function shutdown(exitCode: number): void {
    if (closing) return;
    closing = true;
    for (const callback of pending.values()) {
      clearTimeout(callback.timer);
      callback.reject(Error("Host disconnected"));
    }
    pending.clear();
    // The first shutdown owns the cleanup window. Expiry reports failure so
    // the sandbox owner can reclaim the process without a native confirmation.
    const deadline = setTimeout(() => process.exit(1), STDIO_SHUTDOWN_GRACE_MS);
    void bridge.close().catch(() => {}).then(() => {
      clearTimeout(deadline);
      process.exit(exitCode);
    });
  }

  async function handle(line: string): Promise<void> {
    if (closing) return;
    const decoded = decodeFrame(line);
    if (decoded.kind === "error") {
      write({ jsonrpc: "2.0", id: null, error: decoded.error });
      return;
    }
    const message = decoded.message;
    if (!("method" in message)) {
      const id = String(message.id);
      const callback = pending.get(id);
      if (!callback) return;
      pending.delete(id);
      clearTimeout(callback.timer);
      if ("error" in message && message.error) callback.reject(Error("Host rejected callback"));
      else callback.resolve("result" in message ? message.result : {});
      return;
    }
    if (!("id" in message)) return;
    try {
      const result = await bridge.handle(message.method, message.params as Record<string, unknown>);
      write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const fault = error instanceof CursorError ? error : undefined;
      write({ jsonrpc: "2.0", id: message.id, error: {
        kind: fault?.kind ?? "unknown-outcome",
        code: fault?.code ?? BRIDGE_ERROR_CODES.unknownOutcome,
        message: fault?.message ?? "Cursor SDK operation unconfirmed; no replay",
      } });
    }
  }

  process.stdin.on("data", (data: Buffer) => {
    if (closing) return;
    const batch = splitLines(decoder.write(data), lines);
    lines = { carry: batch.carry, carryBytes: batch.carryBytes, discarding: batch.discarding };
    if (batch.oversized.length) { shutdown(1); return; }
    for (const line of batch.lines) void handle(line).catch(() => shutdown(1));
  });
  process.stdin.on("error", () => shutdown(1));
  process.stdout.on("error", () => shutdown(1));
  process.stdin.once("end", () => shutdown(0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCursorStdio(cursorFactory);
