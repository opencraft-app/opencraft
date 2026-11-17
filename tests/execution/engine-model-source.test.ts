import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../apps/local-agent-host/src/model-config/repository.js";
import { createEngineModelSource, engineEndpointAllowed, EngineModelError } from "../../apps/local-agent-host/src/model-config/engine-models.js";
import { createConfiguredCodexResponses, configuredCodexModelId } from "../../apps/codex-core/src/configured-responses.js";
import { AccountPoolStore, CodexAccountPoolProxy } from "../../packages/account-pool-host/src/index.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "engine-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new ModelConfigurationRepository(directory), credentials = new ModelCredentialRepository(directory);
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

test("each engine declares its protocols over one resolver; Codex exposes only supported routes", async t => {
  const f = await fixture(t);
  const both = createEngineModelSource(f.directory, { protocols: ["openai-responses", "anthropic-messages"] });
  assert.deepEqual((await both.list()).map(r => r.provider.id + "/" + r.model.id), ["responses/r1", "anthropic/a1"]);
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
  await f.repository.update(0, d => { d.providers[1]!.enabled = false; });
  assert.equal((await send(configuredCodexModelId("anthropic", "a1"))).status, 404);
  assert.deepEqual(await createConfiguredCodexResponses(f.directory).catalog(), []);
  assert.equal(calls, 0);
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
