import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSandboxEndpoint,
  type SandboxEndpointConnection,
  type SandboxEndpointTarget,
  type SandboxEnvironment,
} from "@opencraft/sandbox";

/** A private local socket for clients that expect to dial a path. Not an allocator
 * or execution authority: the Host supplies an already-authorized environment and
 * keeps its lease/budget. The path is a capability; keep it off client APIs and logs. */
export interface SandboxEndpointListener {
  /** Unix socket inside a private 0700 directory. */
  readonly path: string;
  /** Stops accepting, ends every connection and removes the directory. Rejects when
   * any relay termination is unconfirmed (also reported via onCleanupUnconfirmed). */
  close(): Promise<void>;
}

/** Each accepted local connection is one `openSandboxEndpoint` connection (one
 * attached sandbox process). Local → sandbox bytes wait for the provider (socket is
 * paused meanwhile); sandbox → local output that the client does not drain beyond
 * `maxBufferedBytes` closes that connection instead of buffering without bound. */
export async function createSandboxEndpointListener(options: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  target: SandboxEndpointTarget;
  python?: string;
  cwd?: string;
  /** Rechecked before opening each connection. */
  authorize(): Promise<void>;
  onCleanupUnconfirmed(): void;
  maxConnections?: number;
  maxBufferedBytes?: number;
  signal?: AbortSignal;
}): Promise<SandboxEndpointListener> {
  options.signal?.throwIfAborted();
  const maxConnections = options.maxConnections ?? 32, maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1)
    throw new Error("Invalid sandbox endpoint listener limits");
  const directory = await mkdtemp(join(tmpdir(), "opencraft-endpoint-"));
  const path = join(directory, "endpoint.sock");
  const sockets = new Set<Socket>(), connections = new Set<Promise<void>>();
  let stopped = false, closing: Promise<void> | undefined, unconfirmed = false;
  const reportUnconfirmed = () => {
    unconfirmed = true;
    try { options.onCleanupUnconfirmed(); } catch {}
  };
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => {
    if (stopped || sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket);
    let connection: SandboxEndpointConnection | undefined, released: Promise<void> | undefined;
    const release = () => released ??= (async () => {
      socket.destroy();
      if (connection) await connection.close().catch(reportUnconfirmed);
    })();
    socket.on("error", () => { void release(); });
    socket.once("close", () => {
      sockets.delete(socket);
      const done = release();
      connections.add(done);
      void done.finally(() => connections.delete(done));
    });
    const opening = (async () => {
      await options.authorize();
      if (stopped || socket.destroyed) return;
      const opened = await openSandboxEndpoint(options.sandbox, {
        target: options.target,
        ...(options.python ? { python: options.python } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        onData(data) {
          if (socket.destroyed) return;
          socket.write(data);
          if (socket.writableLength > maxBufferedBytes) void release();
        },
      });
      connection = opened;
      if (stopped || released) { await opened.close().catch(reportUnconfirmed); return; }
      void opened.closed.then(end => {
        if (end === "ended") socket.end();
        else void release();
      });
      let writes = Promise.resolve();
      socket.on("data", (chunk: Buffer) => {
        socket.pause();
        writes = writes.then(() => opened.write(chunk)).then(() => { if (!released) socket.resume(); }, () => { void release(); });
      });
      socket.on("end", () => {
        writes = writes.then(() => opened.end()).catch(() => { void release(); });
      });
      socket.resume();
    })().catch(() => release());
    // Close also waits for a connection that is still opening.
    connections.add(opening);
    void opening.finally(() => connections.delete(opening));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const close = () => closing ??= (async () => {
    stopped = true;
    options.signal?.removeEventListener("abort", abort);
    const listening = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await listening;
    await Promise.allSettled([...connections]);
    await rm(directory, { recursive: true, force: true });
    if (unconfirmed) throw new Error("Sandbox endpoint cleanup unconfirmed");
  })();
  const abort = () => { void close().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) { await close().catch(() => {}); options.signal.throwIfAborted(); }
  return { path, close };
}
