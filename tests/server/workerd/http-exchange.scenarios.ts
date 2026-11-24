// HTTP exchange scenarios (Miniflare via tests/server/http-exchange-workerd.test.ts
// and the real-Cloudflare rehearsal, scripts/cloudflare/rehearsal.ts). Proves
// that a Headless HTTP service converted to `@opencraft/http-exchange` runs
// unchanged in workerd: the same `serverInformationHttp` answers the same
// request sequence with the same statuses, bodies and headers through the Fetch
// adapter (Durable Object state storage) as through the node:http adapter (file
// state documents), keeps its write across a runtime restart, and a web-stream
// response body reaches the client intact.
// See docs/architecture/platform/gateway-split.md §4.2 (G4).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serveNodeHttpExchange } from "@opencraft/http-exchange/node";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import {
  ServerInformationStore,
  serverInformationHttp,
} from "../../../apps/headless-server/src/server-information.mjs";
import type { WorkerInstance, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";
import { fixtureAuthority, streamedHandler } from "./http-exchange-fixture.ts";

export const HTTP_EXCHANGE_WORKER: WorkerSpec = {
  id: "exchange",
  entry: resolve(import.meta.dirname, "http-exchange-worker.ts"),
  durableObjects: { CORE: "ExchangeCore" },
};

const LOCAL_ORIGIN = "http://exchange.test";
const PATH = "/__opencraft_server_information";
const COMPARED = ["content-type", "cache-control", "x-content-type-options", "x-unowned"];
let sequence = 0;

interface Outcome {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}
interface Call {
  readonly method?: string;
  readonly path?: string;
  readonly actor?: string;
  readonly admin?: boolean;
  /** Origin header: "same" (the entry's origin), a literal, or absent. */
  readonly origin?: string;
  readonly contentType?: string;
  readonly body?: string;
}
interface Entry {
  readonly origin: string;
  call(call: Call): Promise<Outcome>;
}

function init(origin: string, call: Call): RequestInit {
  const headers: Record<string, string> = {};
  if (call.actor) headers["x-fixture-actor"] = call.actor;
  if (call.admin) headers["x-fixture-admin"] = "1";
  if (call.origin) headers.origin = call.origin === "same" ? origin : call.origin;
  if (call.contentType) headers["content-type"] = call.contentType;
  return { method: call.method ?? "GET", headers, ...(call.body === undefined ? {} : { body: call.body }) };
}

async function outcome(response: Response): Promise<Outcome> {
  const headers: Record<string, string> = {};
  for (const name of COMPARED) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const text = await response.text();
  return { status: response.status, headers, body: text ? JSON.parse(text) : null };
}

function workerdEntry(instance: WorkerInstance, object: string): Entry {
  return {
    origin: instance.origin,
    async call(call) {
      const request = init(instance.origin, call);
      (request.headers as Record<string, string>)["x-test-object"] = object;
      return outcome(await instance.fetch(instance.origin + (call.path ?? PATH), request));
    },
  };
}

async function nodeEntry(directory: string): Promise<Entry & { close(): Promise<void> }> {
  let origin = "";
  const handler = serverInformationHttp(
    new ServerInformationStore(fileStateDocumentStore(directory)),
    fixtureAuthority(() => origin),
  );
  const server: Server = createServer((request, response) => {
    void serveNodeHttpExchange(request, response, handler).then((handled) => {
      if (handled) return;
      response.writeHead(404, { "x-unowned": "1" });
      response.end('{"error":"unowned"}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    async call(call) {
      return outcome(await fetch(origin + (call.path ?? PATH), init(origin, call)));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const ADMIN = { actor: "actor-admin", admin: true } as const;
const JSON_POST = { method: "POST", origin: "same", contentType: "application/json" } as const;
/** The request sequence and the answers both entries must give. */
const SEQUENCE: readonly (readonly [string, Call, number, unknown])[] = [
  ["anonymous read", {}, 401, { error: "human_authentication_required" }],
  ["admin read, nothing stored", ADMIN, 200, { revision: 0, publicUrl: "", actorId: "actor-admin", canManage: true }],
  [
    "member read",
    { actor: "actor-member" },
    200,
    { revision: 0, publicUrl: "", actorId: "actor-member", canManage: false },
  ],
  ["unsupported method", { ...ADMIN, method: "PUT" }, 405, { error: "method_not_allowed" }],
  ["member write", { actor: "actor-member", ...JSON_POST, body: "{}" }, 403, { error: "administrator_required" }],
  [
    "cross-origin write",
    { ...ADMIN, ...JSON_POST, origin: "https://elsewhere.test", body: "{}" },
    403,
    { error: "same_origin_required" },
  ],
  [
    "write without origin",
    { ...ADMIN, method: "POST", contentType: "application/json", body: "{}" },
    403,
    { error: "same_origin_required" },
  ],
  [
    "non-JSON write",
    { ...ADMIN, ...JSON_POST, contentType: "text/plain", body: "{}" },
    403,
    { error: "same_origin_required" },
  ],
  [
    "body over 4096 bytes",
    { ...ADMIN, ...JSON_POST, body: JSON.stringify({ publicUrl: "x".repeat(5000) }) },
    413,
    { error: "too_large" },
  ],
  ["malformed JSON", { ...ADMIN, ...JSON_POST, body: "{" }, 400, { error: "invalid_server_information" }],
  [
    "unknown field",
    {
      ...ADMIN,
      ...JSON_POST,
      body: JSON.stringify({ revision: 0, publicUrl: "", expectedActorId: "actor-admin", extra: 1 }),
    },
    400,
    { error: "invalid_server_information" },
  ],
  [
    "account fence",
    { ...ADMIN, ...JSON_POST, body: JSON.stringify({ revision: 0, publicUrl: "", expectedActorId: "actor-other" }) },
    409,
    { error: "account_changed" },
  ],
  [
    "invalid public URL",
    {
      ...ADMIN,
      ...JSON_POST,
      body: JSON.stringify({ revision: 0, publicUrl: "ftp://x", expectedActorId: "actor-admin" }),
    },
    400,
    { error: "invalid_public_url" },
  ],
  [
    "write",
    {
      ...ADMIN,
      ...JSON_POST,
      body: JSON.stringify({ revision: 0, publicUrl: " https://example.test/app/ ", expectedActorId: "actor-admin" }),
    },
    200,
    { revision: 1, publicUrl: "https://example.test/app", actorId: "actor-admin", canManage: true },
  ],
  [
    "stale revision",
    { ...ADMIN, ...JSON_POST, body: JSON.stringify({ revision: 0, publicUrl: "", expectedActorId: "actor-admin" }) },
    409,
    { error: "revision_conflict" },
  ],
  [
    "read after write",
    ADMIN,
    200,
    { revision: 1, publicUrl: "https://example.test/app", actorId: "actor-admin", canManage: true },
  ],
];
const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export const HTTP_EXCHANGE_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "server information: same answers through the Fetch and node:http adapters, durable across restart",
    async run({ runtime, scratch }) {
      const persist = `exchange-${++sequence}`;
      const object = `exchange-${sequence}`;
      const vars = (origin: string) => ({ ORIGIN: origin });
      let instance = await runtime.start(HTTP_EXCHANGE_WORKER, { persist, localOrigin: LOCAL_ORIGIN, vars });
      const directory = await mkdtemp(join(scratch, "server-information-"));
      let node = await nodeEntry(directory);
      try {
        let workerd = workerdEntry(instance, object);
        for (const [label, call, status, body] of SEQUENCE) {
          const [fromWorkerd, fromNode] = [await workerd.call(call), await node.call(call)];
          assert.deepEqual(fromNode, { status, headers: JSON_HEADERS, body }, `node:http — ${label}`);
          assert.deepEqual(fromWorkerd, fromNode, `workerd matches node:http — ${label}`);
        }
        // Routes the service does not own fall through to the caller in both adapters.
        const unowned = { ...ADMIN, path: "/__opencraft_elsewhere" };
        assert.deepEqual(await workerd.call(unowned), await node.call(unowned));
        assert.equal((await node.call(unowned)).headers["x-unowned"], "1");

        // A restart keeps the committed document in both runtimes.
        await runtime.stop(instance);
        await node.close();
        instance = await runtime.start(HTTP_EXCHANGE_WORKER, { persist, localOrigin: LOCAL_ORIGIN, vars });
        node = await nodeEntry(directory);
        workerd = workerdEntry(instance, object);
        const expected = SEQUENCE.at(-1)!;
        const after = await workerd.call(expected[1]);
        assert.deepEqual(after, { status: expected[2], headers: JSON_HEADERS, body: expected[3] });
        assert.deepEqual(await node.call(expected[1]), after);
      } finally {
        await node.close();
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "streamed response body reaches the client through the Fetch adapter",
    async run({ runtime }) {
      const instance = await runtime.start(HTTP_EXCHANGE_WORKER, {
        localOrigin: LOCAL_ORIGIN,
        vars: (origin) => ({ ORIGIN: origin }),
      });
      try {
        const response = await instance.fetch(instance.origin + "/__stream", {
          headers: { "x-test-object": "stream" },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(await response.text(), "alpha beta gamma");
        // The same handler through the node:http adapter gives the same bytes.
        const server = createServer((request, reply) => void serveNodeHttpExchange(request, reply, streamedHandler));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const local = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/__stream`);
          assert.equal(local.headers.get("content-type"), "text/plain; charset=utf-8");
          assert.equal(await local.text(), "alpha beta gamma");
        } finally {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        }
      } finally {
        await runtime.stop(instance);
      }
    },
  },
];
