import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdCompressSync, brotliCompressSync } from "node:zlib";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../apps/local-agent-host/src/model-config/repository.js";
import { createConfiguredCodexResponses, configuredCodexModelId } from "../../apps/codex-core/src/configured-responses.js";
import { AccountPoolStore, CodexAccountPoolProxy } from "../../packages/account-pool-host/src/index.js";

test("configured Responses models project into Codex without moving credentials or choosing defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-configured-"));
  const repository = new ModelConfigurationRepository(directory), credentials = new ModelCredentialRepository(directory);
  const pool = new AccountPoolStore({ databasePath: join(directory, "pool.sqlite"), secretsDirectory: join(directory, "secrets") });
  try {
    await credentials.set("TEST_TOKENHUB", "external-key");
    await repository.initialize({ schemaVersion: 1, revision: 0, defaultModel: null, providers: [{
      id: "test", name: "TokenHub", protocol: "openai-responses", baseUrl: "https://provider.test/prefix/v1",
      credentialRef: "TEST_TOKENHUB", enabled: true, models: [{ id: "ep/test", name: "Endpoint", enabled: true, input: ["text"] }],
    }] });
    const models = createConfiguredCodexResponses(directory), alias = configuredCodexModelId("test", "ep/test");
    const catalog = await models.catalog();
    assert.equal(catalog[0].slug, alias);
    assert.deepEqual(catalog[0].input_modalities, ["text"]);
    assert.deepEqual(catalog[0].supported_reasoning_levels, []);
    assert.equal(catalog[0].default_reasoning_level, null);
    assert.doesNotMatch(JSON.stringify(catalog), /external-key|credentialRef|provider\.test/);
    assert.equal((await repository.read()).defaultModel, null);
    let calls = 0;
    let forwardedSignal: AbortSignal | null = null;
    const proxy = new CodexAccountPoolProxy({ store: pool, configuredResponses: models,
      upstreamBaseUrl: "https://oauth.test/codex", fetch: (async (url, options) => {
        calls++;
        assert.equal(String(url), "https://provider.test/prefix/v1/responses");
        const headers = new Headers(options?.headers);
        assert.equal(headers.get("authorization"), "Bearer external-key");
        for (const key of ["x-opencraft-account-pool-token", "chatgpt-account-id", "x-codex-turn-metadata", "openai-beta"]) assert.equal(headers.get(key), null);
        assert.equal(options?.redirect, "error");
        forwardedSignal = options?.signal as AbortSignal;
        assert.equal(forwardedSignal.aborted, false);
        const body = JSON.parse(String(options?.body));
        assert.equal(body.model, "ep/test");
        assert.equal(body.reasoning, undefined);
        return new Response("data: {\"type\":\"response.completed\"}\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch });
    const token = pool.issueHostToken("local-codex"), abort = new AbortController();
    const make = (model = alias, authenticated = true) => new Request("http://127.0.0.1/v1/responses", {
      method: "POST", signal: abort.signal, headers: { "content-type": "application/json",
        ...(authenticated ? { "x-opencraft-account-pool-token": token } : {}),
        authorization: "Bearer oauth-secret", "chatgpt-account-id": "private-account", "x-codex-turn-metadata": "private-metadata" },
      body: JSON.stringify({ model, input: "hello", stream: true, reasoning: { effort: "medium" } }),
    });
    assert.equal((await proxy.handle(make(alias, false))).status, 401);
    assert.equal(calls, 0);
    const response = await proxy.handle(make());
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.match(await response.text(), /response.completed/);
    assert.equal(calls, 1);
    assert.equal(pool.affinityCount(), 0);
    for (const [encoding, compress] of [["gzip", gzipSync], ["zstd", zstdCompressSync], ["br", brotliCompressSync]] as const) {
      const encoded = compress(Buffer.from(JSON.stringify({ model: alias, input: "hello" })));
      const result = await proxy.handle(new Request("http://127.0.0.1/v1/responses", { method: "POST", signal: abort.signal,
        headers: { "x-opencraft-account-pool-token": token, "content-encoding": encoding }, body: encoded }));
      assert.equal(result.status, 200); await result.text();
    }
    assert.equal(calls, 4);
    const malformed = await proxy.handle(new Request("http://127.0.0.1/v1/responses", { method: "POST",
      headers: { "x-opencraft-account-pool-token": token, "content-encoding": "zstd" }, body: "broken compressed body" }));
    assert.equal(malformed.status, 400); assert.equal(calls, 4);
    const listed = await proxy.handle(new Request("http://127.0.0.1/v1/models", { headers: { "x-opencraft-account-pool-token": token } }));
    assert.equal((await listed.json()).models[0].slug, alias);
    await repository.update(0, draft => { draft.providers[0].enabled = false; });
    assert.equal((await proxy.handle(make())).status, 404);
    assert.equal((await proxy.handle(make("configured/missing/ep"))).status, 404);
    assert.equal(calls, 4);
    assert.deepEqual(await createConfiguredCodexResponses(directory).catalog(), []);
    assert.match(await readFile(credentials.path, "utf8"), /external-key/);
    abort.abort();
    assert.equal((forwardedSignal as AbortSignal | null)?.aborted, true);
  } finally { pool.close(); await rm(directory, { recursive: true, force: true }); }
});

test("configured provider failures never fall through to OAuth and built-in catalogs remain available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-configured-fail-"));
  const pool = new AccountPoolStore({ databasePath: join(directory, "pool.sqlite"), secretsDirectory: join(directory, "secrets") });
  try {
    pool.addAccount({ id: "account", provider: "codex", label: "Existing", upstreamAccountId: "account", priority: 1, enabled: true },
      { accessToken: "oauth", refreshToken: null, expiresAt: null });
    let calls = 0;
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://oauth.test/codex",
      configuredResponses: { catalog: async () => { throw Error("invalid config"); }, resolve: async () => { throw Error("missing credential"); } },
      fetch: (async () => { calls++; return Response.json({ models: [{ slug: "existing-model" }] }); }) as typeof fetch });
    const headers = { "x-opencraft-account-pool-token": pool.issueHostToken("local-codex") };
    const failed = await proxy.handle(new Request("http://local/v1/responses", { method: "POST", headers,
      body: JSON.stringify({ model: "configured/test/ep" }) }));
    assert.equal(failed.status, 503); assert.equal(calls, 0);
    const catalog = await proxy.handle(new Request("http://local/v1/models", { headers }));
    assert.equal((await catalog.json()).models[0].slug, "existing-model"); assert.equal(calls, 1);
  } finally { pool.close(); await rm(directory, { recursive: true, force: true }); }
});
