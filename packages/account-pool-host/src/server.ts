import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { CodexAccountPoolProxy } from "./codex-proxy.js";
import { ACCOUNT_POOL_MAX_REQUEST_BYTES } from "./request-limits.js";

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
  }
  return headers;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const raw of request) {
    // Drain the rest so the client can receive HTTP 413 instead of a reset.
    if (oversized) continue;
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.byteLength;
    if (size > ACCOUNT_POOL_MAX_REQUEST_BYTES) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) throw new RangeError("Request too large");
  return Buffer.concat(chunks);
}

function diagnosticText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/giu, "$1[redacted]")
    .slice(0, 500);
}

function errorDiagnostic(error: unknown): Record<string, string | null> {
  const detail = error !== null && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    : null;
  const cause = detail?.cause !== null && typeof detail?.cause === "object"
    ? detail.cause as { name?: unknown; code?: unknown; message?: unknown }
    : null;
  return {
    errorName: diagnosticText(detail?.name),
    errorCode: diagnosticText(detail?.code),
    errorMessage: diagnosticText(detail?.message),
    causeName: diagnosticText(cause?.name),
    causeCode: diagnosticText(cause?.code),
    causeMessage: diagnosticText(cause?.message),
  };
}

function createConcurrencyLimiter(maximum: number): { acquire(signal?: AbortSignal): Promise<() => void> } {
  let active = 0;
  const waiting: Array<{
    signal?: AbortSignal;
    resolve(release: () => void): void;
    reject(error: unknown): void;
    onAbort(): void;
  }> = [];
  const dispatch = () => {
    while (active < maximum && waiting.length > 0) {
      const entry = waiting.shift()!;
      if (entry.signal?.aborted) continue;
      entry.signal?.removeEventListener("abort", entry.onAbort);
      active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        dispatch();
      });
    }
  };
  return {
    acquire(signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("Account Pool request aborted"));
          return;
        }
        const entry = {
          signal,
          resolve,
          reject,
          onAbort: () => undefined,
        };
        entry.onAbort = () => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(signal?.reason ?? new Error("Account Pool request aborted"));
        };
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        waiting.push(entry);
        dispatch();
      });
    },
  };
}

export async function startCodexAccountPoolServer(options: {
  readonly proxy: CodexAccountPoolProxy;
  readonly host?: string;
  readonly port?: number;
}): Promise<{ readonly url: string; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new TypeError("Account Pool server must bind to loopback");
  let consecutiveProxyFailures = 0;
  const upstreamLimiter = createConcurrencyLimiter(16);
  const active = new Set<Promise<void>>();
  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    const requestStartedAt = Date.now();
    let stage = "read-body";
    let releaseUpstreamSlot: (() => void) | null = null;
    const abort = new AbortController();
    const onAborted = () => abort.abort(new Error("Account Pool client disconnected"));
    const onOutgoingClose = () => { if (!outgoing.writableEnded) onAborted(); };
    incoming.once("aborted", onAborted);
    outgoing.once("close", onOutgoingClose);
    try {
      const body = ["GET", "HEAD"].includes(incoming.method ?? "GET") ? undefined : await requestBody(incoming);
      const authority = incoming.headers.host ?? `${host}:${options.port ?? 0}`;
      stage = "upstream-queue";
      const queueStartedAt = Date.now();
      releaseUpstreamSlot = await upstreamLimiter.acquire(abort.signal);
      const queueWaitMs = Date.now() - queueStartedAt;
      if (queueWaitMs >= 250) {
        console.warn("[opencraft account-pool]", JSON.stringify({
          event: "upstream-queue-delay",
          method: incoming.method ?? "GET",
          path: (incoming.url ?? "/").split("?", 1)[0],
          queueWaitMs,
          concurrencyLimit: 16,
        }));
      }
      stage = "proxy-handle";
      const response = await options.proxy.handle(new Request(`http://${authority}${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers: requestHeaders(incoming),
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
        signal: abort.signal,
      }));
      outgoing.statusCode = response.status;
      outgoing.statusMessage = response.statusText;
      for (const [name, value] of response.headers) outgoing.setHeader(name, value);
      stage = "response-stream";
      if (response.body === null) outgoing.end();
      else await pipeline(
        Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
        outgoing,
        { signal: abort.signal },
      );
      consecutiveProxyFailures = 0;
    } catch (error) {
      if (!abort.signal.aborted && !outgoing.destroyed && !(error instanceof RangeError)) {
        consecutiveProxyFailures += 1;
        console.error("[opencraft account-pool]", JSON.stringify({
          event: "proxy-failure",
          stage,
          method: incoming.method ?? "GET",
          path: (incoming.url ?? "/").split("?", 1)[0],
          durationMs: Date.now() - requestStartedAt,
          consecutiveFailures: consecutiveProxyFailures,
          responseHeadersSent: outgoing.headersSent,
          ...errorDiagnostic(error),
        }));
      }
      if (abort.signal.aborted || outgoing.destroyed) {
        if (!outgoing.destroyed) outgoing.destroy();
      } else if (outgoing.headersSent) {
        if (!outgoing.destroyed) outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        const status = error instanceof RangeError ? 413 : 502;
        outgoing.writeHead(status, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { message: status === 413 ? "Request too large" : "Account Pool request failed" } }));
      }
    } finally {
      releaseUpstreamSlot?.();
      incoming.off("aborted", onAborted);
      outgoing.off("close", onOutgoingClose);
    }
  };
  const server = createServer((incoming, outgoing) => {
    const operation = handle(incoming, outgoing);
    active.add(operation);
    void operation.finally(() => active.delete(operation)).catch(error => {
      if (!outgoing.destroyed) outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Account Pool server did not bind a TCP port");
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closing: Promise<void> | null = null;
  return {
    url: `http://${displayHost}:${address.port}`,
    close: () => closing ??= (async () => {
      // Existing native Turns may need another model request while a different
      // Turn is still streaming. Keep accepting until the proxy is idle; then
      // stop listening synchronously at that idle point. Persistent traffic
      // delays this maintenance rather than consuming native retry budgets.
      while (active.size > 0) await Promise.allSettled([...active]);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // An aborted socket can close before OAuth refresh finishes. Its handler
      // must finish persisting credentials before the owner closes storage.
      await Promise.allSettled(active);
    })(),
  };
}
