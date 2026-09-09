import assert from "node:assert/strict";
import test from "node:test";

import {
  LIGHTVELA_TOKEN_KEY,
  LightVelaAccountService,
} from "../plugins/lightvela-hermes/src/account/lightvela-account-service.ts";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

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
