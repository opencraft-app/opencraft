import assert from "node:assert/strict";
import test from "node:test";

import {
  LIGHTVELA_TOKEN_KEY,
  LightVelaAccountService,
} from "../plugins/lightvela-hermes/src/account/lightvela-account-service.ts";
import { AppServerLightVelaRuntimeCommandPort } from "../plugins/lightvela-hermes/src/account/lightvela-runtime-command-port.ts";
import {
  LIGHTVELA_HERMES_HOST_ID,
  LIGHTVELA_HOST_BINDING_EXTENSION,
} from "../plugins/lightvela-hermes/src/host/lightvela-hermes-host-identity.ts";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol.ts";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("LightVela instance directory returns existing instances without creating or filtering them", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "directory-token");
  const requests: string[] = [];
  const service = new LightVelaAccountService({
    storage,
    apiBase: "https://api.example",
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        code: "OK",
        message: "ok",
        data: {
          total: 2,
          page: 1,
          page_size: 100,
          items: [
            { instance_id: "instance-running", name: "Running", status: "Running", created_at: "2026-09-01T00:00:00Z" },
            { instance_id: "instance-paused", name: "Paused", status: "Paused", created_at: "2026-09-02T00:00:00Z" },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const instances = await service.listInstances();

  assert.deepEqual(requests, ["https://api.example/v1/instances?page=1&page_size=100"]);
  assert.deepEqual(instances, [
    { instanceId: "instance-running", name: "Running", status: "running", createdAt: "2026-09-01T00:00:00Z" },
    { instanceId: "instance-paused", name: "Paused", status: "paused", createdAt: "2026-09-02T00:00:00Z" },
  ]);
  service.dispose();
});

test("LightVela debug execution preserves mono2 request and business-failure semantics", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "test-token");
  let request: Request | null = null;
  const service = new LightVelaAccountService({
    storage,
    apiBase: "https://api.example",
    location: { origin: "https://workbench.example", pathname: "/", search: "", hash: "", assign: () => undefined },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        details: { status: "Failed", exit_code: 7, output: "Hermes rejected the command" },
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await service.execDebugCommand("bot/1", "hermes logs --since 1h");
  assert.deepEqual(result, {
    status: "Failed",
    exitCode: 7,
    output: "Hermes rejected the command",
  });
  assert.equal(request?.url, "https://api.example/v1/instances/bot%2F1/debug/exec");
  assert.equal(request?.headers.get("authorization"), "Bearer test-token");
  assert.deepEqual(await request?.json(), {
    command: "hermes logs --since 1h",
    run_as_user: "agentuser",
  });
  service.dispose();
});

test("LightVela debug streaming preserves mono2 SSE accumulation and final response semantics", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "stream-token");
  let request: Request | null = null;
  const stream = [
    'event: stdout\ndata: {"type":"stdout","chunk":"first"}\n\n',
    'event: stderr\ndata: {"type":"stderr","chunk":" second"}\n\n',
    'event: finished\ndata: {"type":"finished","response":{"status":"SUCCESS","exit_code":0,"output":"first second"}}\n\n',
  ].join("");
  const service = new LightVelaAccountService({
    storage,
    apiBase: "https://api.example",
    location: { origin: "https://workbench.example", pathname: "/", search: "", hash: "", assign: () => undefined },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const chunks: Array<{ stream: string; chunk: string }> = [];
  const result = await service.execDebugCommandStream("bot-1", "acli gateway qr-url --platform weixin --wait true", (chunk) => chunks.push(chunk));
  assert.deepEqual(chunks, [
    { stream: "stdout", chunk: "first" },
    { stream: "stderr", chunk: " second" },
  ]);
  assert.deepEqual(result, { status: "SUCCESS", exitCode: 0, output: "first second" });
  assert.equal(request?.headers.get("accept"), "text/event-stream");
  assert.equal(request?.headers.get("authorization"), "Bearer stream-token");
  service.dispose();
});

test("LightVela debug execution prefers an admitted AppServer command and never calls HTTP", async () => {
  let fetchCalls = 0;
  const service = new LightVelaAccountService({
    storage: new MemoryStorage(),
    apiBase: "https://api.example",
    location: { origin: "https://workbench.example", pathname: "/", search: "", hash: "", assign: () => undefined },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async () => { fetchCalls += 1; throw new Error("HTTP must not own this command"); },
    runtimeCommands: {
      async execIfAvailable(botId, command, onChunk) {
        assert.equal(botId, "bot-1");
        assert.equal(command, "printf native");
        assert.equal(onChunk, undefined);
        return { status: "SUCCESS", exitCode: 0, output: "native" };
      },
    },
  });

  assert.deepEqual(await service.execDebugCommand("bot-1", "printf native"), {
    status: "SUCCESS",
    exitCode: 0,
    output: "native",
  });
  assert.equal(fetchCalls, 0);
  service.dispose();
});

test("LightVela does not replay an admitted AppServer command through HTTP after failure", async () => {
  let fetchCalls = 0;
  const service = new LightVelaAccountService({
    storage: new MemoryStorage(),
    apiBase: "https://api.example",
    location: { origin: "https://workbench.example", pathname: "/", search: "", hash: "", assign: () => undefined },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async () => { fetchCalls += 1; return new Response(); },
    runtimeCommands: {
      async execIfAvailable() { throw new Error("native execution failed"); },
    },
  });

  await assert.rejects(
    service.execDebugCommand("bot-1", "touch /tmp/only-once"),
    /native execution failed/u,
  );
  assert.equal(fetchCalls, 0);
  service.dispose();
});

test("AppServer runtime commands require the exact physical binding and preserve streamed output", async () => {
  let listener: ((notification: { method: string; params: unknown }) => void) | null = null;
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    hostId: LIGHTVELA_HERMES_HOST_ID,
    status: { state: "open" },
    initializeResult: {
      codexHome: "/hermes",
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: "test",
      capabilities: { extensions: {
        [LIGHTVELA_HOST_BINDING_EXTENSION]: { version: 1, instanceId: "bot-1" },
      } },
    },
    subscribeNotification(next: typeof listener) { listener = next; return () => { listener = null; }; },
    async requestRaw(method: string, params: unknown) {
      requests.push({ method, params });
      return { pairing_id: "pair-1", status: "waiting" };
    },
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      if (method === "command/exec") {
        const processId = String(params.processId);
        listener?.({
          method: "command/exec/outputDelta",
          params: { processId, stream: "stdout", deltaBase64: btoa("hello "), capReached: false },
        });
        listener?.({
          method: "command/exec/outputDelta",
          params: { processId, stream: "stderr", deltaBase64: btoa("world"), capReached: false },
        });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return {};
    },
  };
  const port = new AppServerLightVelaRuntimeCommandPort({
    get(hostId: string) { return hostId === LIGHTVELA_HERMES_HOST_ID ? client : null; },
  } as never);
  const chunks: Array<{ stream: string; chunk: string }> = [];

  assert.deepEqual(
    await port.execIfAvailable("bot-1", "printf command", (chunk) => chunks.push(chunk)),
    { status: "SUCCESS", exitCode: 0, output: "hello world" },
  );
  assert.deepEqual(chunks, [
    { stream: "stdout", chunk: "hello " },
    { stream: "stderr", chunk: "world" },
  ]);
  assert.deepEqual((requests[0]?.params as { command: string[] }).command, [
    "/bin/bash", "--noprofile", "--norc", "-lc", "printf command",
  ]);
  assert.equal(await port.execIfAvailable("bot-2", "must-not-run", undefined), null);
  assert.equal(requests.length, 1);

  assert.deepEqual(
    await port.requestIfAvailable("bot-1", "hermes/whatsapp/onboarding/start", { mode: "bot" }),
    { pairing_id: "pair-1", status: "waiting" },
  );
  assert.deepEqual(requests[1], {
    method: "hermes/whatsapp/onboarding/start",
    params: { mode: "bot" },
  });
  assert.equal(
    await port.requestIfAvailable("bot-2", "hermes/whatsapp/onboarding/start", {}),
    null,
  );
});

test("Hermes AppServer initialization publishes its physical instance binding", async () => {
  const initialized = await dispatchAppServerRequest({} as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  }, { instanceId: "bot-physical-1" }) as {
    capabilities: { extensions: Record<string, unknown> };
  };
  assert.deepEqual(
    initialized.capabilities.extensions[LIGHTVELA_HOST_BINDING_EXTENSION],
    { version: 1, instanceId: "bot-physical-1" },
  );
});
