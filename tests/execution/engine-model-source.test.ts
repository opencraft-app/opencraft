import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../apps/local-agent-host/src/model-config/repository.js";
import { createEngineModelSource, engineEndpointAllowed, EngineModelError } from "../../apps/local-agent-host/src/model-config/engine-models.js";
import { createAssistantModelSource } from "../../apps/local-agent-host/src/model-config/assistant.js";
import { createConfiguredCodexResponses, configuredCodexModelId } from "../../apps/codex-core/src/configured-responses.js";
import { AccountPoolStore, CodexAccountPoolProxy } from "../../packages/account-pool-host/src/index.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "engine-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new ModelConfigurationRepository(fileStateDocumentStore(directory)), credentials = new ModelCredentialRepository(directory);
  await credentials.set("RESPONSES_KEY", "responses-secret");
  await credentials.set("ANTHROPIC_KEY", "anthropic-secret");
  await repository.initialize({ schemaVersion: 1, revision: 0, defaultModel: null, providers: [
    { id: "responses", name: "Responses", protocol: "openai-responses", baseUrl: "https://responses.test/v1",
      credentialRef: "RESPONSES_KEY", enabled: true, models: [{ id: "r1", enabled: true }] },
    { id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://anthropic.test/v1",
      credentialRef: "ANTHROPIC_KEY", enabled: true, models: [{ id: "a1", enabled: true }] },
    { id: "completions", name: "Completions", protocol: "openai-completions", baseUrl: "https://completions.test/v1",
      credentialRef: "RESPONSES_KEY", enabled: true, models: [{ id: "c1", enabled: true }] },
  ] });
  return { directory, repository, credentials };
}

test("endpoint policy defaults to HTTPS or loopback; LAN plaintext requires explicit opt-in", () => {
  for (const url of ["https://api.example.com/v1", "http://127.0.0.1:8080/v1", "http://localhost/v1", "http://[::1]/v1"]) {
    assert.equal(engineEndpointAllowed(url), true, url);
  }
  for (const url of ["http://10.1.2.3/v1", "http://192.168.1.20:11434/v1", "http://[fd12:3456::1]/v1", "http://ollama:11434/v1"]) {
    assert.equal(engineEndpointAllowed(url), false, url);
    assert.equal(engineEndpointAllowed(url, true), true, url);
  }
  for (const url of ["http://api.example.com/v1", "http://8.8.8.8/v1", "http://[::ffff:8.8.8.8]/v1", "https://u:p@x.test", "https://x.test/v1?k=1", "not a url"]) {
    assert.equal(engineEndpointAllowed(url, true), false, url);
  }
});

test("LAN opt-in permits only local network HTTP and HTTPS", () => {
  for (const url of ["https://api.example.com/v1", "http://127.0.0.1:8080/v1", "http://localhost/v1", "http://[::1]/v1",
    "http://10.1.2.3/v1", "http://172.16.0.1/v1", "http://172.31.255.255/v1", "http://192.168.1.20:11434/v1", "http://169.254.1.1/v1",
    "http://100.100.1.1/v1", "http://[fd12:3456::1]/v1", "http://[fe80::1]/v1", "http://[::ffff:192.168.1.2]/v1",
    "http://ollama:11434/v1", "http://gpu-box.local/v1", "http://nas.lan/v1", "http://llm.internal/v1", "http://x.home.arpa/v1"]) {
    assert.equal(engineEndpointAllowed(url, true), true, url);
  }
  for (const url of ["http://api.example.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://100.128.0.1/v1",
    "http://[2001:db8::1]/v1", "http://[::ffff:8.8.8.8]/v1", "ftp://10.0.0.1", "https://u:p@x.test", "https://x.test/v1?k=1", "not a url"]) {
    assert.equal(engineEndpointAllowed(url, true), false, url);
  }
});

test("each engine declares its protocols over one resolver; Codex and the assistant agree on the same routes", async t => {
  const f = await fixture(t);
  const both = createEngineModelSource(f.directory, { protocols: ["openai-responses", "anthropic-messages"] });
  assert.deepEqual((await both.list()).map(r => r.provider.id + "/" + r.model.id), ["responses/r1", "anthropic/a1"]);
  const assistant = createAssistantModelSource(f.directory);
  t.after(() => assistant.close());
  assert.deepEqual((await assistant.catalog()).models.map(m => m.providerId), ["responses", "anthropic"]);
  await assert.rejects(assistant.resolve({ providerId: "completions", modelId: "c1" }), /assistant_model_unavailable/);
  // Every assistant route, Responses included, reaches the provider through the loopback gateway; native Codex
  // receives only a per-source gateway token, never the provider credential.
  const connection = await assistant.resolve({ providerId: "responses", modelId: "r1" });
  assert.match(connection.apiKey, /^[0-9a-f]{64}$/u);
  assert.notEqual(connection.apiKey, "responses-secret");
  assert.equal(new URL(connection.baseUrl).hostname, "127.0.0.1");
  const codex = createConfiguredCodexResponses(f.directory);
  assert.deepEqual((await codex.catalog()).map(m => m.slug),
    [configuredCodexModelId("responses", "r1"), configuredCodexModelId("anthropic", "a1")]);
  assert.equal((await codex.resolve(configuredCodexModelId("anthropic", "a1")))?.protocol, "anthropic-messages");
  assert.equal(await codex.resolve(configuredCodexModelId("completions", "c1")), null);
  assert.equal(await codex.resolve("configured/responses/r1/extra"), null);
});

test("a plaintext public endpoint is unselectable for every engine", async t => {
  const f = await fixture(t);
  await f.repository.update(0, d => { d.providers[0]!.baseUrl = "http://api.example.com/v1"; });
  const assistant = createAssistantModelSource(f.directory);
  t.after(() => assistant.close());
  assert.deepEqual((await assistant.catalog()).models.map(m => m.providerId), ["anthropic"]);
  assert.equal(await createConfiguredCodexResponses(f.directory).resolve(configuredCodexModelId("responses", "r1")), null);
});

test("missing credential is a broken connection (503), a disabled model is absent (404); neither falls back", async t => {
  const f = await fixture(t);
  const pool = new AccountPoolStore({ databasePath: join(f.directory, "pool.sqlite"), secretsDirectory: join(f.directory, "secrets") });
  t.after(() => pool.close());
  let calls = 0;
  const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://oauth.test/codex",
    configuredResponses: createConfiguredCodexResponses(f.directory), fetch: (async () => { calls++; return new Response(""); }) as typeof fetch });
  const token = pool.issueHostToken("local-codex");
  const send = (model: string) => proxy.handle(new Request("http://127.0.0.1/v1/responses", { method: "POST",
    headers: { "x-opencraft-account-pool-token": token, "content-type": "application/json" }, body: JSON.stringify({ model, input: "hi" }) }));
  await f.credentials.remove("RESPONSES_KEY");
  await assert.rejects(createEngineModelSource(f.directory, { protocols: ["openai-responses"] }).resolve({ providerId: "responses", modelId: "r1" }),
    (error: unknown) => error instanceof EngineModelError && error.code === "credential");
  assert.equal((await send(configuredCodexModelId("responses", "r1"))).status, 503);
  const assistant = createAssistantModelSource(f.directory);
  t.after(() => assistant.close());
  await assert.rejects(assistant.resolve({ providerId: "responses", modelId: "r1" }), /assistant_model_unavailable/);
  await f.repository.update(0, d => { d.providers[1]!.enabled = false; });
  assert.equal((await send(configuredCodexModelId("anthropic", "a1"))).status, 404);
  assert.deepEqual(await createConfiguredCodexResponses(f.directory).catalog(), []);
  assert.equal(calls, 0);
});

test("assistant reaches Anthropic through a loopback gateway that holds the credential and re-resolves per request", async t => {
  const f = await fixture(t);
  const upstream: { url: string; key: string | null; version: string | null; body: any }[] = [];
  const events = [
    { type: "message_start", message: { id: "msg-1", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Anthropic" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }];
  const fakeFetch = (async (url: URL | string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    upstream.push({ url: String(url), key: headers.get("x-api-key"), version: headers.get("anthropic-version"), body: JSON.parse(String(options?.body)) });
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const assistant = createAssistantModelSource(f.directory, undefined, { fetch: fakeFetch });
  t.after(() => assistant.close());
  const resolved = await assistant.resolve({ providerId: "anthropic", modelId: "a1" });
  assert.match(resolved.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/routes\/anthropic\/a1\/v1$/u);
  assert.notEqual(resolved.apiKey, "anthropic-secret");
  assert.deepEqual(await assistant.resolve({ providerId: "anthropic", modelId: "a1" }), resolved, "stable across turn/start re-resolution");
  const post = (key: string | undefined, body: unknown = { model: "a1", input: "hi", stream: true }) => fetch(resolved.baseUrl + "/responses", {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post(undefined)).status, 401);
  assert.equal((await post("wrong")).status, 401);
  assert.equal(upstream.length, 0);
  const ok = await post(resolved.apiKey);
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.match(text, /Hello from Anthropic/u);
  assert.match(text, /response\.completed/u);
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0]!.url, "https://anthropic.test/v1/messages");
  assert.equal(upstream[0]!.key, "anthropic-secret");
  assert.equal(upstream[0]!.version, "2023-06-01");
  assert.equal(upstream[0]!.body.model, "a1");
  await f.credentials.set("ANTHROPIC_KEY", "rotated-secret");
  await (await post(resolved.apiKey)).text();
  assert.equal(upstream[1]!.key, "rotated-secret", "rotation applies without a new native session");
  await f.repository.update(0, d => { d.providers[1]!.enabled = false; });
  assert.equal((await post(resolved.apiKey)).status, 503);
  assert.equal(upstream.length, 2);
  await assistant.close();
  await assert.rejects(post(resolved.apiKey));
});

test("credential resolution fails closed if the configuration revision changes", async t => {
  const f = await fixture(t);
  const original = ModelCredentialRepository.prototype.resolve;
  ModelCredentialRepository.prototype.resolve = async function(reference) {
    const result = await original.call(this, reference);
    await f.repository.update(0, document => { document.providers[0]!.baseUrl = "https://replacement.test/v1"; });
    return result;
  };
  t.after(() => { ModelCredentialRepository.prototype.resolve = original; });
  await assert.rejects(createEngineModelSource(f.directory, { protocols: ["openai-responses"] }).resolve({ providerId: "responses", modelId: "r1" }),
    (error: unknown) => error instanceof EngineModelError && error.code === "changed");
});

test("LAN opt-in is applied by the resolver and Codex projection, not just the URL predicate", async t => {
  const f = await fixture(t);
  await f.repository.update(0, document => { document.providers[0]!.baseUrl = "http://192.168.1.20:11434/v1"; });
  const alias = configuredCodexModelId("responses", "r1");
  assert.equal(await createConfiguredCodexResponses(f.directory).resolve(alias), null);
  assert.equal((await createConfiguredCodexResponses(f.directory, { allowInsecureLocalNetwork: true }).resolve(alias))?.apiKey, "responses-secret");
});
