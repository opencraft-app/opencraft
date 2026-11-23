// Shared conformance suite for the runtime-neutral HTTP exchange port
// (@opencraft/identity-core/http-exchange): the same cases run against the
// node:http adapter (a real listener) and the Fetch Request/Response adapter.
// See docs/architecture/platform/gateway-split.md §3.4.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createServer, request as nodeRequest } from "node:http";
import { once } from "node:events";
import {
  HttpBodyTooLarge,
  HttpExchangeAborted,
  decodeUtf8,
  type HttpExchangeHandler,
  type HttpExchangeRequest,
} from "@opencraft/identity-core/http-exchange";
import { serveNodeHttpExchange } from "@opencraft/identity-core/http-exchange-node";
import { serveFetchHttpExchange } from "@opencraft/identity-core/http-exchange-fetch";

interface Call {
  readonly method?: string;
  readonly path: string;
  readonly headers?: readonly (readonly [string, string])[];
  /** Sent as separate chunks. */
  readonly chunks?: readonly Uint8Array[];
  /** Abort (client disconnect) once the handler reports it is waiting. */
  readonly abortWhen?: Promise<void>;
}
type Outcome =
  | { readonly kind: "response"; readonly status: number; readonly headers: [string, string][]; readonly body: string }
  | { readonly kind: "unhandled" }
  | { readonly kind: "dropped" };
interface Adapter {
  readonly name: string;
  /** Host the handler must observe. */
  readonly host: string;
  /** Client address the handler must observe. */
  readonly clientAddress: string | null;
  run(handler: HttpExchangeHandler, call: Call): Promise<Outcome>;
}

const encoder = new TextEncoder();
const bytes = (size: number, fill = 0x61) => new Uint8Array(size).fill(fill);
const RELEVANT = new Set(["set-cookie", "content-type", "cache-control", "x-order", "location"]);

const nodeAdapter: Adapter = {
  name: "node:http",
  host: "",
  clientAddress: "127.0.0.1",
  async run(handler, call) {
    const server = createServer((req, res) => {
      void serveNodeHttpExchange(req, res, handler).then(
        (handled) => { if (!handled) { res.writeHead(599); res.end(); } },
        () => { res.writeHead(598); res.end(); },
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    (nodeAdapter as { host: string }).host = `127.0.0.1:${port}`;
    try {
      return await new Promise<Outcome>((resolve) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of call.headers ?? []) headers[name] = value;
        const request = nodeRequest({ host: "127.0.0.1", port, method: call.method ?? "GET", path: call.path, headers });
        request.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            if (response.statusCode === 599) return resolve({ kind: "unhandled" });
            const list: [string, string][] = [];
            for (let i = 0; i < response.rawHeaders.length; i += 2) {
              const name = response.rawHeaders[i]!.toLowerCase();
              if (RELEVANT.has(name)) list.push([name, response.rawHeaders[i + 1]!]);
            }
            resolve({ kind: "response", status: response.statusCode!, headers: list, body: Buffer.concat(chunks).toString("utf8") });
          });
        });
        request.on("error", () => resolve({ kind: "dropped" }));
        void call.abortWhen?.then(() => request.destroy());
        void (async () => {
          for (const chunk of call.chunks ?? []) {
            request.write(chunk);
            await new Promise((done) => setTimeout(done, 5));
          }
          if (!call.abortWhen) request.end();
        })();
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
};

const fetchAdapter: Adapter = {
  name: "fetch",
  host: "entry.test",
  clientAddress: "203.0.113.9",
  async run(handler, call) {
    const controller = new AbortController();
    void call.abortWhen?.then(() => controller.abort());
    const chunks = call.chunks;
    const body = chunks?.length
      ? new ReadableStream<Uint8Array>({
          async start(stream) {
            for (const chunk of chunks) {
              stream.enqueue(chunk);
              await new Promise((done) => setTimeout(done, 5));
            }
            stream.close();
          },
        })
      : undefined;
    const request = new Request(`http://entry.test${call.path}`, {
      method: call.method ?? "GET",
      headers: (call.headers ?? []).map(([name, value]) => [name, value] as [string, string]),
      signal: controller.signal,
      ...(body ? { body, duplex: "half" } : {}),
    } as RequestInit);
    let response: Response | null;
    try {
      response = await serveFetchHttpExchange(request, handler, { clientAddress: "203.0.113.9" });
    } catch (error) {
      if (error instanceof HttpExchangeAborted) return { kind: "dropped" };
      throw error;
    }
    if (!response) return { kind: "unhandled" };
    const headers: [string, string][] = [];
    for (const [name, value] of response.headers) if (RELEVANT.has(name) && name !== "set-cookie") headers.push([name, value]);
    const cookies = response.headers.getSetCookie().map((value) => ["set-cookie", value] as [string, string]);
    return { kind: "response", status: response.status, headers: [...cookies, ...headers], body: await response.text() };
  },
};

for (const adapter of [nodeAdapter, fetchAdapter]) {
  describe(`HTTP exchange conformance: ${adapter.name}`, () => {
    test("method, path with query, lower-cased headers, raw list, host and client address", async () => {
      let seen: HttpExchangeRequest | undefined;
      const outcome = await adapter.run(async (request) => {
        seen = request;
        return { status: 200, headers: [["content-type", "text/plain"]], body: "ok" };
      }, { method: "PUT", path: "/a/b?x=1&y=%20", headers: [["X-Probe", "one"], ["Accept-Language", "de"]], chunks: [encoder.encode("{}")] });
      assert.deepEqual(outcome, { kind: "response", status: 200, headers: [["content-type", "text/plain"]], body: "ok" });
      assert.equal(seen!.method, "PUT");
      assert.equal(seen!.path, "/a/b?x=1&y=%20");
      assert.equal(seen!.headers["x-probe"], "one");
      assert.equal(seen!.headers["accept-language"], "de");
      assert.equal(seen!.headers["X-Probe"], undefined);
      assert.equal(seen!.headers.host, adapter.host);
      const raw = seen!.rawHeaders;
      assert.equal(raw.length % 2, 0);
      assert.ok(raw.some((name, i) => i % 2 === 0 && name.toLowerCase() === "x-probe" && raw[i + 1] === "one"));
      assert.equal(seen!.clientAddress, adapter.clientAddress);
      // The identity view describes the same request.
      assert.equal(seen!.identity.method, "PUT");
      assert.equal(seen!.identity.url, "/a/b?x=1&y=%20");
      assert.equal(seen!.identity.headers["x-probe"], "one");
      assert.equal(seen!.signal.aborted, false);
    });

    test("headers keep list order and every set-cookie value", async () => {
      const outcome = await adapter.run(async () => ({
        status: 201,
        headers: [["set-cookie", "a=1; Path=/; HttpOnly"], ["set-cookie", "b=; Path=/x; Max-Age=0"], ["x-order", "first"],
          ["content-type", "application/json; charset=utf-8"], ["cache-control", "private, no-store"]],
        body: JSON.stringify({ ok: true }),
      }), { path: "/" });
      assert.equal(outcome.kind, "response");
      const { status, body, headers } = outcome as Extract<Outcome, { kind: "response" }>;
      assert.equal(status, 201);
      assert.equal(body, '{"ok":true}');
      // Every set-cookie value survives, in order and ahead of the others (node:http sends list order;
      // Fetch Headers keep cookie order and sort other names, which carry no meaning by order).
      assert.deepEqual(headers.slice(0, 2), [["set-cookie", "a=1; Path=/; HttpOnly"], ["set-cookie", "b=; Path=/x; Max-Age=0"]]);
      assert.deepEqual(headers.slice(2).sort(), [["cache-control", "private, no-store"], ["content-type", "application/json; charset=utf-8"], ["x-order", "first"]]);
      if (adapter === nodeAdapter) assert.deepEqual(headers.slice(2).map(([name]) => name), ["x-order", "content-type", "cache-control"]);
    });

    test("null body, redirect without body, binary body and unowned routes", async () => {
      assert.deepEqual(await adapter.run(async () => ({ status: 204, headers: [["cache-control", "no-store"]], body: null }), { path: "/" }),
        { kind: "response", status: 204, headers: [["cache-control", "no-store"]], body: "" });
      assert.deepEqual(await adapter.run(async () => ({ status: 303, headers: [["location", "/next"]], body: null }), { path: "/" }),
        { kind: "response", status: 303, headers: [["location", "/next"]], body: "" });
      assert.deepEqual(await adapter.run(async () => ({ status: 200, headers: [], body: encoder.encode("bytes ü") }), { path: "/" }),
        { kind: "response", status: 200, headers: [], body: "bytes ü" });
      assert.deepEqual(await adapter.run(async () => null, { path: "/elsewhere" }), { kind: "unhandled" });
    });

    test("streamed body is read exactly up to the limit, once", async () => {
      const limit = 16_384;
      let read: Uint8Array | undefined, second: unknown;
      const outcome = await adapter.run(async (request) => {
        read = await request.readBody(limit);
        second = await request.readBody(limit).then(() => null, (error: unknown) => error);
        return { status: 200, headers: [], body: String(read.byteLength) };
      }, { method: "POST", path: "/", chunks: [bytes(8_000), bytes(8_000, 0x62), bytes(384, 0x63)] });
      assert.deepEqual(outcome, { kind: "response", status: 200, headers: [], body: String(limit) });
      assert.equal(read![0], 0x61);
      assert.equal(read![8_000], 0x62);
      assert.equal(read![limit - 1], 0x63);
      assert.ok(second instanceof Error && !(second instanceof HttpBodyTooLarge));
    });

    test("no body reads as empty; UTF-8 split across chunks decodes intact", async () => {
      const empty = await adapter.run(async (request) => ({ status: 200, headers: [], body: String((await request.readBody(10)).byteLength) }), { path: "/" });
      assert.deepEqual(empty, { kind: "response", status: 200, headers: [], body: "0" });
      const text = encoder.encode('{"name":"ä"}');
      const split = text.indexOf(0xc3) + 1;
      const decoded = await adapter.run(async (request) => ({ status: 200, headers: [], body: JSON.parse(decodeUtf8(await request.readBody(100))).name }),
        { method: "POST", path: "/", chunks: [text.slice(0, split), text.slice(split)] });
      assert.deepEqual(decoded, { kind: "response", status: 200, headers: [], body: "ä" });
    });

    test("body over the limit stops reading and the handler's 413 is delivered", async () => {
      let error: unknown;
      const outcome = await adapter.run(async (request) => {
        try { await request.readBody(16_384); } catch (cause) { error = cause; }
        return { status: 413, headers: [["content-type", "application/json"]], body: '{"error":"too_large"}' };
      }, { method: "POST", path: "/", chunks: [bytes(10_000), bytes(6_385), bytes(50_000)] });
      assert.ok(error instanceof HttpBodyTooLarge);
      assert.equal((error as HttpBodyTooLarge).limit, 16_384);
      assert.deepEqual(outcome, { kind: "response", status: 413, headers: [["content-type", "application/json"]], body: '{"error":"too_large"}' });
    });

    test("client disconnect aborts the exchange signal", async () => {
      let waiting!: () => void;
      const reached = new Promise<void>((resolve) => { waiting = resolve; });
      let aborted!: (value: boolean) => void;
      const observed = new Promise<boolean>((resolve) => { aborted = resolve; });
      const outcome = adapter.run(async (request) => {
        request.signal.addEventListener("abort", () => aborted(true), { once: true });
        waiting();
        await Promise.race([observed, new Promise((done) => setTimeout(done, 5_000))]);
        if (request.signal.aborted) throw new HttpExchangeAborted();
        aborted(false);
        return { status: 200, headers: [], body: "late" };
      }, { method: "POST", path: "/", chunks: [bytes(10)], abortWhen: reached });
      assert.equal(await observed, true);
      assert.equal((await outcome).kind, "dropped");
    });

    test("HttpExchangeAborted drops the exchange without a response", async () => {
      assert.deepEqual(await adapter.run(async () => { throw new HttpExchangeAborted(); }, { path: "/" }), { kind: "dropped" });
    });
  });
}
