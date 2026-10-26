import type { ExecutionLease, NativeExecutionState } from "./execution-lease-store.js";
import { CodexCoreReadIsolation } from "./codex-core-read-isolation.js";
import { randomUUID } from "node:crypto";

type NativeRead = (method: "thread/turns/list", params: {
  threadId: string; limit: number; sortDirection: "desc"; itemsView: "notLoaded";
}, signal: AbortSignal) => Promise<unknown>;

/** The request port MUST connect directly to the attested native/Host authority.
 * It may initialize a read connection, but must never resume, subscribe, steer,
 * acquire tools or change interaction ownership. Read failure stays unknown. */
export function createNativeExecutionTurnInspector(request: NativeRead, timeoutMs = 1500) {
  return async (lease: ExecutionLease): Promise<NativeExecutionState> => {
    if (!lease.turnId || !lease.engineIncarnation) return "unknown";
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const cancelled = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Execution inspection timed out")), { once: true }));
      const value = await Promise.race([Promise.resolve().then(() => request("thread/turns/list", {
        threadId: lease.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      }, signal)), cancelled]);
      if (!value || typeof value !== "object") return "unknown";
      const data = (value as { data?: unknown }).data;
      if (!Array.isArray(data) || data.length !== 1) return "unknown";
      const latest = data[0];
      if (!latest || typeof latest.id !== "string" || !["inProgress", "completed", "interrupted", "failed"].includes(latest.status)) return "unknown";
      if (latest.id !== lease.turnId) return "finished";
      return latest.status === "inProgress" ? "active" : "finished";
    } catch { return "unknown"; }
  };
}

/** Authenticated Core health supplies the existing routing/native socket.
 * Reuses the existing bounded history-only reader; no callback lane is claimed. */
export function createCodexExecutionTurnInspector(health: () => Promise<{ nativeSocket: string }>) {
  const reads = new CodexCoreReadIsolation(health, { maxPayload: 1024 * 1024, concurrency: 4, queue: 16, timeoutMs: 1500 });
  return {
    inspect: createNativeExecutionTurnInspector(async (method, params) => {
      const message = JSON.parse(await reads.read({ id: `execution-inspection:${randomUUID()}`, method, params }));
      if (message.error) throw new Error("Native execution unavailable");
      return message.result;
    }),
    close: () => reads.close(),
  };
}

/** Ephemeral history-only sockets for independent local Hosts. Uses raw RPC so
 * unsolicited server requests are ignored instead of auto-answered by a Client.
 * resolveTarget must revalidate the deployment's private Host descriptor. */
export async function createWebSocketExecutionTurnInspector(resolveTarget: () => Promise<string>) {
  const { default: WebSocket } = await import("ws");
  const sockets = new Set<InstanceType<typeof WebSocket>>();
  let closed = false;
  const request = async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
      const target = new URL(await resolveTarget());
      if (target.protocol !== "ws:" || target.hostname !== "127.0.0.1" || target.username || target.password
        || closed || signal.aborted || sockets.size >= 4) throw new Error("Local execution reader unavailable");
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(target, { handshakeTimeout: 1500, maxPayload: 1024 * 1024 });
        sockets.add(socket);
        const id = `execution-read:${randomUUID()}`, init = `${id}:initialize`;
        let initialized = false, settled = false;
        const finish = (value: unknown, error?: Error) => {
          if (settled) return; settled = true;
          signal.removeEventListener("abort", abort);
          sockets.delete(socket); socket.terminate();
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(undefined, new Error("Execution read cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        socket.on("error", () => finish(undefined, new Error("Execution read unavailable")));
        socket.on("close", () => finish(undefined, new Error("Execution read closed")));
        socket.on("open", () => {
          if (signal.aborted || closed) { abort(); return; }
          socket.send(JSON.stringify({ id: init, method: "initialize", params: {
            clientInfo: { name: "opencraft-execution-history-reader", version: "1" }, capabilities: { experimentalApi: true },
          } }));
        });
        socket.on("message", raw => {
          try {
            const message = JSON.parse(String(raw));
            if (!message || typeof message !== "object" || Array.isArray(message)) { abort(); return; }
            if (typeof message.method === "string") return; // Never own or answer a native interaction.
            if (!initialized && message.id === init) {
              if (message.error || !("result" in message)) { abort(); return; }
              initialized = true;
              socket.send('{"method":"initialized","params":{}}');
              socket.send(JSON.stringify({ id, method, params }));
            } else if (initialized && message.id === id) {
              message.error || !("result" in message) ? abort() : finish(message.result);
            }
          } catch { abort(); }
        });
      });
    };
  return {
    inspect: createNativeExecutionTurnInspector(request),
    // Recover exact original inputs without Resume or a tool callback lane.
    readThread: (threadId: string) => request("thread/read", {threadId, includeTurns:true}, AbortSignal.timeout(1500)),
    close() { closed = true; for (const socket of sockets) socket.terminate(); sockets.clear(); },
  };
}

/** ACP's native history uses native Turn numbering; the independent ACP owner
 * retains the actual admitted public Turn/input. Read it through authenticated
 * /execution-origin, never compare unrelated native transcript Turn IDs. */
export function createHostExecutionTurnInspector(observe: (threadId: string) => Promise<{
  pid: number | null; turn?: {id:string; status:string; inputId:string | null} | null;
}>, fallback: (lease: ExecutionLease) => Promise<NativeExecutionState>) {
  return async (lease: ExecutionLease): Promise<NativeExecutionState> => {
    try {
      const current = await observe(lease.threadId);
      if (current.turn === undefined) return fallback(lease);
      if (!current.pid || !current.turn || !lease.turnId) return "unknown";
      if (current.turn.id !== lease.turnId) return "finished";
      if (current.turn.inputId !== lease.inputId) return "unknown";
      return current.turn.status === "inProgress" ? "active" : ["completed","interrupted","failed"].includes(current.turn.status) ? "finished" : "unknown";
    } catch { return "unknown"; }
  };
}
