import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { dirname } from "node:path";
import type { Socket } from "node:net";
import { removeStaleSocket } from "./native-process.js";

/** Authenticated local control only. Closing drains accepted account mutations. */
export async function startControlServer(endpoint: string, token: string,
  handle: (request: IncomingMessage) => Promise<{ status: number; value: unknown }>) {
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  if (((await stat(dirname(endpoint))).mode & 0o077) !== 0) throw new Error("Codex socket directory must be private");
  await removeStaleSocket(endpoint);
  let closing = false;
  const active = new Set<Promise<void>>();
  const connections = new Map<Socket, number>();
  const server = createServer((request, response) => {
    const socket = request.socket;
    connections.set(socket, (connections.get(socket) ?? 0) + 1);
    let finished = false;
    const finishResponse = () => {
      if (finished) return;
      finished = true;
      if (!connections.has(socket)) return;
      const remaining = connections.get(socket)! - 1;
      connections.set(socket, remaining);
      if (closing && remaining === 0) socket.destroySoon();
    };
    response.once("finish", finishResponse);
    response.once("close", finishResponse);
    const operation = (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
      let result: { status: number; value: unknown };
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        result = { status: 401, value: { error: "Codex core authentication failed" } };
      } else if (closing) result = { status: 503, value: { error: "Codex service is closing" } };
      else {
        try { result = await handle(request); }
        catch { result = { status: 503, value: { error: "Codex service unavailable" } }; }
      }
      response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result.value));
    })();
    active.add(operation);
    void operation.finally(() => active.delete(operation)).catch(() => response.destroy());
  });
  server.on("connection", socket => {
    if (!connections.has(socket)) connections.set(socket, 0);
    socket.once("close", () => connections.delete(socket));
    if (closing && connections.get(socket) === 0) socket.destroySoon();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
  try { await chmod(endpoint, 0o600); }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); await unlink(endpoint); throw error; }
  return { async close() {
    closing = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    // A partial HTTP header (or a body ignored by an already answered read)
    // has no accepted operation to drain, but Node otherwise waits for its
    // parser timeout. Preserve running handlers and flush their responses.
    for (const [socket, pending] of connections) if (pending === 0) socket.destroySoon();
    await closed;
    await Promise.allSettled(active);
    await unlink(endpoint).catch(() => undefined);
  } };
}

/** Same bounded JSON envelope used by the private account and generation planes. */
export async function readControlJson(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Control request too large");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control request");
  return value as Record<string, unknown>;
}
