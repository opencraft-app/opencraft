import { lstat } from "node:fs/promises";
import { connect, type Socket } from "node:net";

export interface NativeControlLease {
  isValid(): boolean;
  subscribeRevoked(listener: () => void): () => void;
  key(symbol: number, down: boolean): void;
  pointer(x: number, y: number, mask: number): void;
  release(): void;
}
export interface NativeDesktopControl {
  inspect(signal: AbortSignal): Promise<string>;
  acquire(incarnation: string, signal: AbortSignal): Promise<NativeControlLease>;
}
const unavailable = () => new Error("Desktop control unavailable");

/** Private root-owned Unix endpoint, not a configurable TCP/shell target. A
 * fresh connection owns each lease; EOF/timeout revokes input in the executor. */
export function createNativeDesktopControl(): NativeDesktopControl {
  async function open(signal: AbortSignal) {
    signal.throwIfAborted();
    const directory = "/run/opencraft-desktop-control";
    const parent = await lstat(directory), file = await lstat(`${directory}/control.sock`);
    if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o077
      || !file.isSocket() || file.uid !== 0 || file.mode & 0o077) throw unavailable();
    let socket: Socket;
    const listeners = new Set<() => void>();
    const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(): void; timer: ReturnType<typeof setTimeout> }>();
    let retired = false, sequence = 0, buffer = Buffer.alloc(0);
    const retire = () => {
      if (retired) return; retired = true; socket?.destroy();
      signal.removeEventListener("abort", retire);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(); }
      pending.clear();
      for (const listener of [...listeners]) { try { listener(); } catch { /* Finish retirement. */ } }
      listeners.clear();
    };
    signal.addEventListener("abort", retire, { once: true });
    socket = connect(`${directory}/control.sock`);
    socket.on("error", retire); socket.on("close", retire);
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > 65536) { retire(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while (!retired && (end = buffer.indexOf(10)) >= 0) {
        if (end > 1024) { retire(); return; }
        try {
          const reply = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          buffer = buffer.subarray(end + 1);
          const request = pending.get(reply.id);
          if (!request || reply.ok !== true) throw unavailable();
          pending.delete(reply.id); clearTimeout(request.timer); request.resolve(reply);
        } catch { retire(); }
      }
    });
    const request = (value: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (retired || signal.aborted || pending.size >= 256 || socket.writableLength > 65536) {
        retire(); return Promise.reject(unavailable());
      }
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(retire, 1500); timer.unref();
        pending.set(id, { resolve, reject: () => reject(unavailable()), timer });
        socket.write(`${JSON.stringify({ ...value, id })}\n`, error => { if (error) retire(); });
      });
    };
    if (signal.aborted) retire();
    return { request, retire, isValid: () => !retired && !signal.aborted,
      subscribe(listener: () => void) { if (retired) { listener(); return () => {}; }
        listeners.add(listener); return () => { listeners.delete(listener); }; } };
  }
  const identity = (value: Record<string, unknown>): string => {
    if (value.protocol !== "opencraft-desktop-control" || value.version !== 1
      || typeof value.incarnation !== "string" || !/^[a-f0-9]{64}$/.test(value.incarnation)) throw unavailable();
    return value.incarnation;
  };
  return {
    async inspect(signal) {
      const client = await open(signal);
      try { return identity(await client.request({ op: "probe" })); }
      finally { client.retire(); }
    },
    async acquire(incarnation, signal) {
      const client = await open(signal);
      try {
        if (identity(await client.request({ op: "acquire", incarnation })) !== incarnation || !client.isValid()) throw unavailable();
        const timer = setInterval(() => { void client.request({ op: "renew" }).catch(client.retire); }, 1000); timer.unref();
        client.subscribe(() => clearInterval(timer));
        return { isValid: client.isValid, subscribeRevoked: client.subscribe,
          key: (symbol, down) => { void client.request({ op: "key", symbol, down }).catch(client.retire); },
          pointer: (x, y, mask) => { void client.request({ op: "pointer", x, y, mask }).catch(client.retire); },
          release: client.retire };
      } catch { client.retire(); throw unavailable(); }
    },
  };
}
