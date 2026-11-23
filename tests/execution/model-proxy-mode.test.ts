import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { AccountPoolStore, CodexAccountPoolProxy } from "../../packages/account-pool-host/src/index.js";
import { ModelConfigurationApplyError, ModelConfigurationService, PROXY_CALLER_REFERENCE, proxyProjection, proxyRouting } from "../../apps/local-agent-host/src/model-config/service.js";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../apps/local-agent-host/src/model-config/repository.js";
import { PROXY_MODE_CREDENTIAL_MESSAGE, ProxyModelCredentials, engineModelCredentials } from "../../apps/local-agent-host/src/model-config/engine-credentials.js";
import { fileModelCredentials } from "../../apps/local-agent-host/src/model-config/engine-models.js";
import { createPiModelConfiguration } from "../../apps/local-agent-host/src/model-config/pi-adapter.js";
import { DshModelConfigurationBridge, DshModelEngineAdapter, ProductModelEngine } from "../../apps/local-agent-host/src/model-config/dsh-adapter.js";
import { fileSecretStore } from "@opencraft/secret-storage/file";
import type { ModelDocument } from "../../apps/local-agent-host/src/model-config/model-document.js";

const caller = { caller: "caller:pi", baseUrl: "http://127.0.0.1:45071", token: "t".repeat(43) };
const model = [{ id: "m", enabled: true }];
const p = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, protocol: "openai-completions", baseUrl: "https://api.example/v1",
  credentialRef: "KEY_" + id.replace(/-/g, "_"), enabled: true, models: model, ...extra });

/** Every provider kind an engine (Pi, DSH) can be configured with, and how proxy mode handles it. */
const MATRIX: [string, Record<string, unknown>, "proxy" | "keyless" | "rejected"][] = [
  ["anthropic-messages explicit endpoint", { protocol: "anthropic-messages" }, "proxy"],
  ["openai-responses explicit endpoint", { protocol: "openai-responses" }, "proxy"],
  ["openai-completions explicit endpoint", {}, "proxy"],
  ["DSH native DeepSeek", { catalogId: "deepseek", baseUrl: "https://api.deepseek.com" }, "proxy"],
  ["loopback HTTP endpoint", { baseUrl: "http://127.0.0.1:11434/v1" }, "proxy"],
  ["catalog default endpoint (no baseUrl)", { catalogId: "anthropic", protocol: "anthropic-messages", baseUrl: "" }, "rejected"],
  ["google-generative-ai", { protocol: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, "rejected"],
  ["other Pi API (mistral-conversations)", { protocol: "mistral-conversations" }, "rejected"],
  ["plain HTTP LAN endpoint", { baseUrl: "http://192.168.1.20:8000/v1" }, "rejected"],
  ["no-auth OpenAI-compatible", { authentication: "none", credentialRef: null }, "keyless"],
  ["no credential reference", { credentialRef: null }, "keyless"],
  ["human contribution (Core-owned)", { catalogId: "opencraft-human-contribution", protocol: "openai-responses" }, "keyless"],
  ["human subscription (Core-owned)", { catalogId: "opencraft-human-subscription", protocol: "openai-responses" }, "keyless"],
  ["speech hunyuan-asr (Gateway-owned)", { protocol: "hunyuan-asr", models: [{ id: "asr", type: "asr", enabled: true }] }, "keyless"],
];

test("proxy routing matrix: every engine provider kind is routed through the proxy, keyless or rejected with a reason", () => {
  for (const [label, extra, expected] of MATRIX) {
    const routing = proxyRouting(p("x", extra) as any, caller);
    assert.equal(routing.route, expected, label);
    if (routing.route === "rejected") assert.match(routing.reason, /“x”/u, label);
  }
  assert.equal((proxyRouting(p("hub", { protocol: "anthropic-messages" }) as any, caller) as any).baseUrl, caller.baseUrl + "/providers/hub");
  assert.equal((proxyRouting(p("ds") as any, caller) as any).baseUrl, caller.baseUrl + "/providers/ds/v1");
});

test("the proxy projection never passes a provider key: rejected providers are removed and their default is cleared", () => {
  const doc = { schemaVersion: 1, revision: 1, defaultModel: { providerId: "gemini", modelId: "m" },
    providers: [p("ds"), p("gemini", { protocol: "google-generative-ai" }), p("free", { authentication: "none", credentialRef: null })] } as any;
  const next = proxyProjection(doc, caller);
  assert.deepEqual(next.providers.map(v => v.id), ["ds", "free"]);
  assert.equal(next.providers[0]!.credentialRef, PROXY_CALLER_REFERENCE);
  assert.equal(next.providers[1]!.credentialRef, null);
  assert.equal(next.defaultModel, null);
  assert.equal(proxyProjection({ ...doc, defaultModel: { providerId: "ds", modelId: "m" } }, caller).defaultModel?.providerId, "ds");
});

async function documents(t: test.TestContext, seed: ModelDocument) {
  const dir = await mkdtemp(join(tmpdir(), "opencraft-proxy-mode-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const models = join(dir, "models"); await mkdir(models, { mode: 0o700 });
  const repository = new ModelConfigurationRepository(fileStateDocumentStore(models)); await repository.initialize(seed);
  return { dir, models, repository };
}
const sealed = { stamp: async () => "proxy", resolve: async () => { throw new Error("read"); }, configured: async () => true,
  set: async () => undefined, remove: async () => undefined };

test("proxy mode refuses saving a provider that would need a local key; unchanged legacy providers still load", async t => {
  const legacy = p("gemini", { protocol: "google-generative-ai" });
  const f = await documents(t, { schemaVersion: 1, revision: 0, defaultModel: null, providers: [legacy] } as any);
  const applied: ModelDocument[] = [];
  const service = new ModelConfigurationService(f.repository, sealed, { apply: async doc => { applied.push(doc); } }, caller);
  assert.equal((await service.synchronize()).state, "applied");
  assert.deepEqual(applied.at(-1)!.providers, [], "legacy unroutable provider is excluded, not connected directly");
  // Editing an unrelated provider keeps the untouched legacy one.
  await service.update(0, draft => { draft.providers.push(p("ds") as any); });
  await assert.rejects(service.update(1, draft => { draft.providers.push(p("claude", { protocol: "anthropic-messages", baseUrl: "", catalogId: "anthropic" }) as any); }),
    (error: Error) => error instanceof ModelConfigurationApplyError && /服务地址/u.test(error.message));
  await assert.rejects(service.update(1, draft => { draft.providers[0]!.models = [{ id: "m2", enabled: true }]; }), /连接协议不能经模型代理转发/u);
  await assert.rejects(service.update(1, draft => { draft.defaultModel = { providerId: "gemini", modelId: "m" }; }), /连接协议/u);
  // Disabling an unroutable provider is always allowed.
  await service.update(1, draft => { draft.providers[0]!.enabled = false; });
  assert.equal((await f.repository.read()).revision, 2);
});

test("proxy-mode engine composition never opens credentials.json and resolves routed providers to the proxy", async t => {
  const f = await documents(t, { schemaVersion: 1, revision: 0, defaultModel: { providerId: "ds", modelId: "m" },
    providers: [p("ds"), p("claude", { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" }),
      p("gemini", { protocol: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" })] } as any);
  // Any read of the credentials file would fail: it is a symlink, which the private store refuses to open.
  await symlink("/nonexistent-opencraft-credentials", join(f.models, "credentials.json"));
  const callerFile = join(f.dir, "pi.json"); await writeFile(callerFile, JSON.stringify(caller), { mode: 0o600 });
  const composition = await engineModelCredentials(f.models, { OPENCRAFT_PROXY_CALLER_FILE: callerFile });
  assert.ok(composition.credentials instanceof ProxyModelCredentials);
  assert.deepEqual(composition.caller, caller);
  await assert.rejects(composition.credentials.resolve("KEY_ds"), (error: Error) => error.message === PROXY_MODE_CREDENTIAL_MESSAGE);
  // Embedded mode keeps the local file owner (and would therefore hit the unsafe file).
  const embedded = await engineModelCredentials(f.models, {});
  assert.ok(embedded.credentials instanceof ModelCredentialRepository);
  await assert.rejects(embedded.credentials.resolve("KEY_ds"));

  const pi = await createPiModelConfiguration(f.repository, composition.credentials, fileStateDocumentStore(join(f.dir, "pi")), composition.caller);
  await pi.configuration.synchronize();
  const ds = pi.models.getModel("ds", "m")!, claude = pi.models.getModel("claude", "m")!;
  assert.equal(ds.baseUrl, caller.baseUrl + "/providers/ds/v1");
  assert.equal(claude.baseUrl, caller.baseUrl + "/providers/claude");
  assert.equal(pi.models.getModel("gemini", "m"), undefined, "rejected provider is not executable");
  const auth = await (pi.models.getProvider("ds") as any).auth.apiKey.resolve();
  assert.equal(auth.auth.apiKey, caller.token);
  assert.equal(pi.configuration.defaults().model, "pi:ds:m");

  const calls: [string, any][] = [];
  const client = { call: async (method: string, payload: any = {}) => {
    calls.push([method, payload]);
    if (method === "settings.describe") return { writable: true, hasDocument: true, namespaces: ["llm-pi-ai", "llm-deepseek", "agent-default-model"].map(ns => ({ ns, revision: 1, value: {}, base: {} })) };
    return {};
  } };
  const dsh = new ModelConfigurationService(f.repository, composition.credentials, new DshModelEngineAdapter(client as any), composition.caller);
  assert.equal((await dsh.synchronize()).state, "applied", dsh.application.error);
  const sets = calls.filter(([m]) => m === "credentials.set").map(([, v]) => v.value);
  assert.deepEqual([...new Set(sets)], [caller.token], "DSH receives only the caller token");
  const profiles = calls.find(([m, v]) => m === "settings.mutate" && v.ns === "llm-pi-ai")![1].ops.find((op: any) => op.path[0] === "providers").value;
  assert.deepEqual(Object.keys(profiles).sort(), ["claude", "ds"]);
  assert.equal(profiles.ds.baseURL, caller.baseUrl + "/providers/ds/v1");
});

test("proxy-mode credential writes reach the account Core through the proxy, which never returns a value", async t => {
  const f = await documents(t, { schemaVersion: 1, revision: 0, defaultModel: null, providers: [] } as any);
  const store = new AccountPoolStore({ databasePath: join(f.dir, "pool.sqlite"), secretsDirectory: join(f.dir, "secrets") });
  t.after(() => store.close());
  const proxy = new CodexAccountPoolProxy({ store, upstreamBaseUrl: "https://chatgpt.invalid/backend-api/codex",
    fetch: (async () => { throw new Error("no upstream"); }) as typeof fetch, modelCredentials: fileModelCredentials(f.models) });
  const through = () => (async (url: any, init: any) => proxy.handle(new Request(url, init))) as typeof fetch;
  const pi = { ...caller, token: store.issueHostToken("caller:pi") };
  const port = new ProxyModelCredentials(pi, through());
  assert.equal(await port.configured("KEY_ds"), false);
  await port.set("KEY_ds", "sk-provider-secret");
  assert.equal(await port.configured("KEY_ds"), true);
  assert.equal(await new ModelCredentialRepository(fileSecretStore(f.models)).resolve("KEY_ds"), "sk-provider-secret", "stored by the Core owner");
  await port.remove("KEY_ds");
  assert.equal(await port.configured("KEY_ds"), false);
  await assert.rejects(port.set("bad ref", "x"), /凭据格式无效/u);
  // The assistant caller and Codex Host tokens cannot write engine credentials; unknown operations are refused.
  for (const token of [store.issueHostToken("caller:assistant"), store.issueHostToken("local-codex"), "nope"])
    assert.equal((await proxy.handle(new Request(caller.baseUrl + "/model-credentials", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ op: "describe", refs: ["KEY_ds"] }) }))).status, 401);
  assert.equal((await proxy.handle(new Request(caller.baseUrl + "/model-credentials", { method: "POST", headers: { authorization: "Bearer " + pi.token }, body: JSON.stringify({ op: "get", ref: "KEY_ds" }) }))).status, 400);

  // The DSH settings bridge reports presence from the Core and never from the Brain environment.
  process.env.KEY_ENV_ONLY = "env-secret"; t.after(() => { delete process.env.KEY_ENV_ONLY; });
  await port.set("KEY_STORED", "v");
  const service = new ModelConfigurationService(f.repository, port, { apply: async () => undefined }, pi);
  const bridge = new DshModelConfigurationBridge({ call: async () => ({}) } as any, service);
  const described = await bridge.call<any>("credentials.describe", { refs: ["KEY_STORED", "KEY_ENV_ONLY"] });
  assert.equal(described.credentials.KEY_STORED.configured, true);
  assert.equal(described.credentials.KEY_ENV_ONLY.configured, false);
});

test("the DSH settings bridge turns a proxy-mode refusal into a definitive settings rejection", async t => {
  const f = await documents(t, { schemaVersion: 1, revision: 0, defaultModel: null, providers: [] } as any);
  const raw = { writable: true, hasDocument: true, namespaces: ["llm-pi-ai", "llm-deepseek", "agent-default-model"].map(ns => ({ ns, revision: 1, value: {}, base: {} })) };
  const bridge = new DshModelConfigurationBridge({ call: async (method: string) => method === "settings.describe" ? raw : method === "llm.providers" ? { providers: [] } : {} } as any,
    new ModelConfigurationService(f.repository, sealed, { apply: async () => undefined }, caller));
  await assert.rejects(bridge.call("settings.mutate", { ns: "llm-pi-ai", expectedRevision: 0, ops: [{ op: "set", path: ["providers", "gemini"],
    value: { displayName: "Gemini", api: "google-generative-ai", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_KEY", models: [{ id: "g" }] } }] }),
    (error: any) => error.code === "settings-rejected" && /连接协议不能经模型代理转发/u.test(error.message));
  assert.equal((await f.repository.read()).revision, 0, "nothing was committed");
});

test("without DSH the settings bridge keeps proxy-mode ownership: keys reach only the account Core, unroutable providers are refused", async t => {
  const f = await documents(t, { schemaVersion: 1, revision: 0, defaultModel: null, providers: [] } as any);
  const writes: any[] = [];
  // The account Core's write-only endpoint; it never returns a value and is the only place a key may go.
  const core = (async (url: any, init: any) => {
    assert.equal(String(url), caller.baseUrl + "/model-credentials");
    assert.equal(init.headers.authorization, "Bearer " + caller.token);
    const body = JSON.parse(init.body); writes.push(body);
    return new Response(JSON.stringify(body.op === "describe" ? { configured: Object.fromEntries(body.refs.map((ref: string) => [ref, writes.some(w => w.op === "set" && w.ref === ref)])) } : {}), { status: 200 });
  }) as typeof fetch;
  const credentials = new ProxyModelCredentials(caller, core);
  const engineCalls: string[] = [];
  const absent = { call: async (method: string) => { engineCalls.push(method);
    if (method === "settings.describe") return { namespaces: [] };
    if (method === "llm.providers") return { providers: [] };
    throw Object.assign(new Error("DSH is not installed"), { code: "DSH_UNAVAILABLE" }); } };
  const bridge = new DshModelConfigurationBridge(absent as any, new ModelConfigurationService(f.repository, credentials, new ProductModelEngine(), caller), false);
  await bridge.initialize();
  assert.equal(bridge.config.application.state, "applied");
  const described = await bridge.call<any>("settings.describe");
  assert.equal(described.writable, true);
  assert.deepEqual(described.namespaces.map((n: any) => n.ns).sort(), ["agent-default-model", "llm-deepseek", "llm-pi-ai"]);

  // The proxy rejection matrix is enforced on the no-DSH path as well, before anything is committed.
  for (const [label, extra, expected] of MATRIX) {
    if (extra.catalogId || extra.protocol === "hunyuan-asr") continue; // catalog/Core/speech kinds are not created through llm-pi-ai profiles
    const id = "m" + MATRIX.findIndex(row => row[0] === label);
    const before = (await f.repository.read()).revision;
    const profile = { displayName: label, api: extra.protocol ?? "openai-completions", baseURL: extra.baseUrl ?? "https://api.example/v1", enabled: true,
      ...(extra.authentication === "none" ? { authentication: "none" } : extra.credentialRef === null ? {} : { apiKeyEnv: "KEY_" + id }), models: [{ id: "m" }] };
    const attempt = bridge.call("settings.mutate", { ns: "llm-pi-ai", expectedRevision: before, ops: [{ op: "set", path: ["providers", id], value: profile }] });
    if (expected === "rejected") {
      await assert.rejects(attempt, (error: any) => error.code === "settings-rejected", label);
      assert.equal((await f.repository.read()).revision, before, `${label}: nothing committed`);
    } else { await attempt; assert.equal((await f.repository.read()).revision, before + 1, label); }
  }

  await bridge.call("credentials.set", { ref: "KEY_m2", value: "sk-provider-secret" });
  assert.deepEqual(writes.filter(w => w.op === "set"), [{ op: "set", ref: "KEY_m2", value: "sk-provider-secret" }], "the key went to the Core only");
  assert.equal((await bridge.call<any>("credentials.describe", { refs: ["KEY_m2"] })).credentials.KEY_m2.configured, true);
  await assert.rejects(stat(join(f.models, "credentials.json")), { code: "ENOENT" }, "the engine host never writes a local key file");
  await bridge.call("settings.describe");
  assert.equal(bridge.config.application.state, "applied", "a key change re-applies without an engine");
  assert.ok(!engineCalls.some(method => method.startsWith("credentials.")), "no key is projected to an absent engine");
});
