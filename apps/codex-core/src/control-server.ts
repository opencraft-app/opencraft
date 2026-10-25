import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { removeStaleSocket } from "./native-process.js";

/** Authenticated local control only. Closing drains accepted account mutations. */
export async function startControlServer(endpoint: string, token: string,
  handle: (request: IncomingMessage) => Promise<{ status: number; value: unknown }>) {
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  if (((await stat(dirname(endpoint))).mode & 0o077) !== 0) throw new Error("Codex socket directory must be private");
  await removeStaleSocket(endpoint);
  let closing = false;
  const active = new Set<Promise<void>>();
  const server = createServer((request, response) => {
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
  try { await chmod(endpoint, 0o600); }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); await unlink(endpoint); throw error; }
  return { async close() {
    closing = true;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled(active);
    await unlink(endpoint).catch(() => undefined);
  } };
}

/** Same bounded JSON envelope used by the private account and generation planes. */
export async function readControlJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Control request too large");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control request");
  return value as Record<string, unknown>;
}
