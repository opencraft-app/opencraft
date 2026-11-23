import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigurationService, PROXY_CALLER_REFERENCE, proxyProjection, readProxyCaller } from "../../apps/local-agent-host/src/model-config/service.js";

const provider = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, protocol: "anthropic-messages", baseUrl: "https://p.example/v1", credentialRef: "KEY_" + id, enabled: true, models: [{ id: "m", enabled: true }], ...extra });
const document = (providers: unknown[]) => ({ schemaVersion: 1, revision: 3, providers, defaultModel: null }) as any;
const caller = { caller: "caller:pi", baseUrl: "http://127.0.0.1:45071", token: "t".repeat(43) };

test("authenticated providers with explicit endpoints are projected through the proxy with the caller token reference", () => {
  const next = proxyProjection(document([
    provider("hub"), provider("oa", { protocol: "openai-responses" }), provider("free", { authentication: "none", credentialRef: null }),
    provider("catalog", { baseUrl: "" }), provider("human", { catalogId: "opencraft-human-x" }), provider("chat", { protocol: "openai-completions" }),
  ]), caller);
  const by = Object.fromEntries(next.providers.map((p: any) => [p.id, p]));
  assert.equal(by.hub.baseUrl, "http://127.0.0.1:45071/providers/hub"); assert.equal(by.hub.credentialRef, PROXY_CALLER_REFERENCE);
  assert.equal(by.oa.baseUrl, "http://127.0.0.1:45071/providers/oa/v1");
  // Chat Completions is passed through natively too.
  assert.equal(by.chat.baseUrl, "http://127.0.0.1:45071/providers/chat/v1"); assert.equal(by.chat.credentialRef, PROXY_CALLER_REFERENCE);
  // Keyless providers stay as configured; a catalog default endpoint cannot be proxied and is not executed at all.
  for (const id of ["free", "human"]) assert.deepEqual(by[id], document([]).providers.concat(next.providers).find((p: any) => p.id === id));
  assert.equal(by.catalog, undefined);
});

test("caller records are validated; the engine receives the projection and the caller token, never the provider key", async t => {
  const dir = await mkdtemp(join(tmpdir(), "opencraft-proxy-caller-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "pi.json");
  assert.equal(await readProxyCaller({}), null);
  await writeFile(file, JSON.stringify({ ...caller, baseUrl: "http://evil.example:1" })); await assert.rejects(readProxyCaller({ OPENCRAFT_PROXY_CALLER_FILE: file }));
  await writeFile(file, JSON.stringify({ ...caller, baseUrl: caller.baseUrl + "/" }));
  assert.deepEqual(await readProxyCaller({ OPENCRAFT_PROXY_CALLER_FILE: file }), caller);
  const applied: any[] = [];
  const service = new ModelConfigurationService({ read: async () => document([provider("hub")]) } as any,
    { stamp: async () => "s", resolve: async () => { throw new Error("proxy mode must not resolve a provider key"); } } as any,
    { apply: async (doc: any, creds: any) => { applied.push({ doc, key: await creds.resolve(doc.providers[0].credentialRef) }); } }, caller);
  assert.equal((await service.synchronize(true)).state, "applied");
  assert.equal(applied[0].doc.providers[0].baseUrl, "http://127.0.0.1:45071/providers/hub");
  assert.equal(applied[0].key, caller.token);
});
