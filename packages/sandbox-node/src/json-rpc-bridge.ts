import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, WebSocket } from "ws";
import type { SandboxCommand, SandboxEnvironment, SandboxProcess } from "@opencraft/sandbox";

/** A private one-connection transport, not an allocator or execution authority.
 * The Host supplies the already-authorized sandbox and retains its lease/budget.
 * URLs are bearer capabilities: keep them off client APIs, logs and Thread data. */
export interface SandboxJsonRpcBridge {
  readonly url: string;
  close(): Promise<void>;
}
export async function createSandboxJsonRpcBridge(options: {
  sandbox: Pick<SandboxEnvironment, "spawn">;
  command: SandboxCommand;
  /** Rechecked before spawning and before forwarding each native request. */
  authorize(): Promise<void>;
  onLost(): void;
  signal?: AbortSignal;
}): Promise<SandboxJsonRpcBridge> {
  options.signal?.throwIfAborted();
  await options.authorize();
  options.signal?.throwIfAborted();
  if (options.command.terminal) throw new Error("JSON RPC transport requires a non-terminal process");
  const maximumFrame = 4 * 1024 * 1024,
    maximumBuffered = 8 * 1024 * 1024;
  const capability = Buffer.from("/" + randomBytes(32).toString("hex"));
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maximumFrame, perMessageDeflate: false });
  const pendingTransports = new Set<Duplex>();
  let claimed = false,
    stopped = false,
    lost = false;
  let socket: WebSocket | undefined, child: SandboxProcess | undefined;
  let starting: Promise<void> | undefined, closing: Promise<void> | undefined;
  let queue = Promise.resolve(),
    queuedBytes = 0,
    queuedFrames = 0;
  const decoder = new StringDecoder("utf8");
  let output = "";
  const reportLost = () => {
    if (!lost) {
      lost = true;
      try {
        options.onLost();
      } catch {}
    }
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      stopped = true;
      options.signal?.removeEventListener("abort", abort);
      pendingTransports.forEach((transport) => transport.destroy());
      pendingTransports.clear();
      socket?.terminate();
      sockets.clients.forEach((client) => client.terminate());
      const listeningClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      sockets.close();
      await starting?.catch(() => {});
      // A failed terminate must reach the lease owner; never claim cleanup succeeded.
      try {
        if (child) await child.terminate();
      } finally {
        await listeningClosed;
      }
    })());
  const fail = () => {
    if (!stopped) {
      reportLost();
      void close().catch(reportLost);
    }
  };
  const abort = () => {
    void close().catch(reportLost);
  };
  const sendOutput = (data: Uint8Array) => {
    if (stopped) return;
    output += decoder.write(Buffer.from(data));
    if (Buffer.byteLength(output) > maximumBuffered) {
      fail();
      return;
    }
    for (;;) {
      const newline = output.indexOf("\n");
      if (newline < 0) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (!line.length) continue;
      if (
        Buffer.byteLength(line) > maximumFrame ||
        socket?.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > maximumBuffered
      ) {
        fail();
        return;
      }
      try {
        const v: unknown = JSON.parse(line);
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw Error();
      } catch {
        fail();
        return;
      }
      socket.send(line, (error) => {
        if (error) fail();
      });
    }
    if (Buffer.byteLength(output) > maximumFrame) fail();
  };
  server.on("upgrade", (request, transport, head) => {
    const supplied = Buffer.from(request.url ?? "");
    if (
      stopped ||
      claimed ||
      request.headers.origin !== undefined ||
      supplied.length !== capability.length ||
      !timingSafeEqual(supplied, capability)
    ) {
      transport.destroy();
      return;
    }
    // Reserve before async authorization; a second handshake cannot win a race.
    claimed = true;
    pendingTransports.add(transport);
    transport.once("close", () => pendingTransports.delete(transport));
    const reject = () => {
      transport.destroy();
      fail();
    };
    transport.once("error", reject);
    void options
      .authorize()
      .then(() => {
        if (stopped || transport.destroyed) {
          reject();
          return;
        }
        sockets.handleUpgrade(request, transport, head, (ws) => {
          pendingTransports.delete(transport);
          transport.off("error", reject);
          socket = ws;
          ws.on("error", fail);
          ws.on("close", fail);
          ws.on("message", (data) => {
            if (stopped) return;
            const bytes = Buffer.isBuffer(data)
              ? data
              : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
            if (bytes.length > maximumFrame || queuedBytes + bytes.length > maximumBuffered || queuedFrames >= 64) {
              fail();
              return;
            }
            // A WebSocket frame represents one JSON message, never an injected second line.
            let value: unknown;
            try {
              value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            } catch {
              fail();
              return;
            }
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              fail();
              return;
            }
            const frame = Buffer.from(JSON.stringify(value) + "\n");
            queuedBytes += bytes.length;
            queuedFrames++;
            queue = queue
              .then(async () => {
                await starting;
                if (stopped) return;
                await options.authorize();
                if (!stopped) await child!.writeStdin(frame);
              })
              .catch(fail)
              .finally(() => {
                queuedBytes -= bytes.length;
                queuedFrames--;
              });
          });
          starting = (async () => {
            await options.authorize();
            if (stopped) return;
            child = await options.sandbox.spawn(options.command, (event) => {
              if (event.stream === "stdout") sendOutput(event.data);
            });
            if (child.kind !== "process") throw new Error("Unexpected terminal transport");
            // Lease owner handles process exit as loss, never replay/reconnect.
            void child.exited.then(() => fail(), fail);
          })();
          void starting.catch(fail);
        });
      }, reject)
      .catch(reject);
  });
  server.on("error", fail);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    await close();
    options.signal.throwIfAborted();
  }
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}${capability.toString()}`, close };
}
