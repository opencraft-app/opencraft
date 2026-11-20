import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPoolStore, CodexAccountPoolProxy, PROXY_CALLERS } from "../../packages/account-pool-host/src/index.js";

async function fixture(t: any, fetchImpl: typeof fetch, protocol: "anthropic-messages" | "openai-responses" = "anthropic-messages") {
  const root = await mkdtemp(join(tmpdir(), "opencraft-proxy-provider-"));
  const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const resolved: string[] = [];
  const proxy = new CodexAccountPoolProxy({ store, upstreamBaseUrl: "https://chatgpt.invalid/backend-api/codex", fetch: fetchImpl,
    configuredResponses: { catalog: async () => [], resolve: async (model: string) => { resolved.push(model);
      return model === "configured/tokenhub/claude-x" ? { baseUrl: "https://provider.example/v1/", model: "upstream-claude", protocol, apiKey: "provider-secret" } : null; } } });
  return { store, proxy, resolved };
}
const post = (path: string, headers: Record<string, string>, body: unknown) =>
  new Request("http://127.0.0.1:45071" + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("provider passthrough authenticates callers, injects only the provider credential and streams the native response", async t => {
  const seen: { url: string; headers: Headers; body: any }[] = [];
  const f = await fixture(t, (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response("event: message_start\n\n", { status: 200, headers: { "content-type": "text/event-stream", "x-upstream-secret": "no" } });
  }) as typeof fetch);
  const token = f.store.issueHostToken("caller:pi");
  const response = await f.proxy.handle(post("/providers/tokenhub/v1/messages", { "x-api-key": token, "anthropic-beta": "b1", accept: "text/event-stream" }, { model: "claude-x", stream: true, max_tokens: 8 }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "event: message_start\n\n");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://provider.example/v1/messages");
  assert.equal(seen[0]!.headers.get("x-api-key"), "provider-secret");
  assert.equal(seen[0]!.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(seen[0]!.headers.get("anthropic-beta"), "b1");
  assert.equal(seen[0]!.headers.get("authorization"), null);
  assert.deepEqual(seen[0]!.body, { model: "upstream-claude", stream: true, max_tokens: 8 });
  assert.deepEqual(f.resolved, ["configured/tokenhub/claude-x"]);
  for (const path of ["/providers/tokenhub/messages", "/providers/tokenhub/v1/v1/messages"])
    assert.equal((await f.proxy.handle(post(path, { "x-api-key": token }, { model: "claude-x" }))).status, 200, path);
  assert.equal(seen.at(-1)!.url, "https://provider.example/v1/messages");
  // Bearer form is accepted too (OpenAI-style SDKs).
  assert.equal((await f.proxy.handle(post("/providers/tokenhub/v1/messages", { authorization: "Bearer " + token }, { model: "claude-x" }))).status, 200);
});

test("provider passthrough refuses unknown callers, Codex Host tokens, wrong protocol and unknown models without dispatching", async t => {
  let calls = 0;
  const f = await fixture(t, (async () => { calls++; return new Response("{}"); }) as typeof fetch);
  const caller = f.store.issueHostToken("caller:dsh"), codexHost = f.store.issueHostToken("local-codex");
  assert.equal((await f.proxy.handle(post("/providers/tokenhub/v1/messages", {}, { model: "claude-x" }))).status, 401);
  assert.equal((await f.proxy.handle(post("/providers/tokenhub/v1/messages", { "x-api-key": codexHost }, { model: "claude-x" }))).status, 401);
  assert.equal((await f.proxy.handle(post("/providers/tokenhub/v1/responses", { "x-api-key": caller }, { model: "claude-x" }))).status, 400);
  assert.equal((await f.proxy.handle(post("/providers/tokenhub/v1/messages", { "x-api-key": caller }, { model: "other" }))).status, 404);
  assert.equal((await f.proxy.handle(post("/providers/tokenhub/v1/messages", { "x-api-key": caller }, { nomodel: 1 }))).status, 400);
  assert.equal((await f.proxy.handle(post("/providers/tokenhub/v1/v1/v1/messages", { "x-api-key": caller }, { model: "claude-x" }))).status, 404);
  assert.equal(calls, 0);
});

test("caller tokens cannot reach the ChatGPT subscription account pool", async t => {
  let calls = 0;
  const f = await fixture(t, (async () => { calls++; return new Response("{}"); }) as typeof fetch);
  const caller = f.store.issueHostToken("caller:assistant");
  for (const request of [post("/v1/responses", { "x-opencraft-account-pool-token": caller }, { model: "gpt-x", input: [] }),
    new Request("http://127.0.0.1:45071/v1/models", { headers: { "x-opencraft-account-pool-token": caller } })])
    assert.equal((await f.proxy.handle(request)).status, 401);
  assert.equal(calls, 0);
  assert.deepEqual([...PROXY_CALLERS], ["caller:pi", "caller:dsh", "caller:assistant"]);
});
