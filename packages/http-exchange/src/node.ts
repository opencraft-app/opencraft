// node:http adapter for the HTTP exchange port. Wire output matches services
// that wrote `ServerResponse` directly: headers are set in list order (so
// earlier `set-cookie` precedes the service's content headers), then
// `writeHead(status)` and `end(body)`; Node adds Date/Connection/framing.
// A stream body is written chunk by chunk with backpressure.
import type { IncomingMessage, ServerResponse } from "node:http";
// Value imports go through the package export so plain `node` (type stripping, no specifier rewriting) can load this entry.
import {
  HttpBodyTooLarge,
  HttpExchangeAborted,
  type HttpExchangeHandler,
  type HttpExchangeRequest,
  type HttpExchangeResponse,
} from "@opencraft/http-exchange";

interface NodeExchange {
  readonly request: HttpExchangeRequest<IncomingMessage>;
  /** Writes the response, then releases an overflowed body stream. */
  send(result: HttpExchangeResponse): Promise<void>;
  /** Drops the connection without a response. */
  abort(): void;
  dispose(): void;
}

function singleValues(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) values[name] = Array.isArray(value) ? value.join(", ") : value;
  return values;
}

async function writeStream(response: ServerResponse, stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (response.destroyed) {
        cancel();
        return;
      }
      if (!response.write(next.value))
        await new Promise<void>((resolve) => {
          const done = () => {
            response.off("drain", done);
            response.off("close", done);
            resolve();
          };
          response.on("drain", done);
          response.on("close", done);
        });
    }
    response.end();
  } catch {
    // The status is already on the wire: a failed stream drops the exchange.
    response.destroy();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Wraps one node:http request. `identity` is the IncomingMessage itself, so per-request provider caches stay shared with the gateway. */
export function nodeHttpExchange(request: IncomingMessage, response: ServerResponse): NodeExchange {
  const controller = new AbortController();
  const onClose = () => {
    if (!response.writableFinished) controller.abort();
  };
  if (response.destroyed) controller.abort();
  else response.once("close", onClose);
  let used = false;
  let overflowed: AsyncIterator<unknown> | null = null;
  const exchange: HttpExchangeRequest<IncomingMessage> = {
    method: request.method ?? "",
    path: request.url ?? "/",
    headers: singleValues(request.headers),
    rawHeaders: request.rawHeaders,
    clientAddress: request.socket?.remoteAddress ?? null,
    signal: controller.signal,
    identity: request,
    async readBody(limit: number): Promise<Uint8Array> {
      if (used) throw new Error("Request body already read");
      used = true;
      const iterator = request[Symbol.asyncIterator]();
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = next.value as Buffer | string;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        // Stop reading; the stream is released only after the response is written.
        if (size > limit) {
          overflowed = iterator;
          throw new HttpBodyTooLarge(limit);
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    },
  };
  const release = async () => {
    const iterator = overflowed;
    overflowed = null;
    if (iterator) await iterator.return?.().catch(() => undefined);
  };
  return {
    request: exchange,
    async send(result) {
      const grouped = new Map<string, string[]>();
      for (const [name, value] of result.headers) {
        const values = grouped.get(name);
        if (values) values.push(value);
        else grouped.set(name, [value]);
      }
      for (const [name, values] of grouped)
        response.setHeader(name, name === "set-cookie" || values.length > 1 ? values : values[0]!);
      response.writeHead(result.status);
      const body = result.body;
      if (body === null) response.end();
      else if (typeof body === "string" || body instanceof Uint8Array) response.end(body);
      else await writeStream(response, body, controller.signal);
      await release();
    },
    abort() {
      response.destroy();
      void release();
    },
    dispose() {
      response.off("close", onClose);
    },
  };
}

/**
 * Runs a port handler for one node:http request. Resolves false when the
 * handler does not own the route (nothing written). `HttpExchangeAborted`
 * destroys the connection; other failures propagate to the caller unwritten.
 */
export async function serveNodeHttpExchange(
  request: IncomingMessage,
  response: ServerResponse,
  handler: HttpExchangeHandler<IncomingMessage>,
): Promise<boolean> {
  const exchange = nodeHttpExchange(request, response);
  try {
    let result: HttpExchangeResponse | null;
    try {
      result = await handler(exchange.request);
    } catch (error) {
      if (error instanceof HttpExchangeAborted) {
        exchange.abort();
        return true;
      }
      throw error;
    }
    if (!result) return false;
    await exchange.send(result);
    return true;
  } finally {
    exchange.dispose();
  }
}
