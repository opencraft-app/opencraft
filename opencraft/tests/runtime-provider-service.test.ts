import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { RuntimeProviderService } from "../apps/local-agent-host/src/runtime-provider-service.js";
import { DshClientError } from "../apps/local-agent-host/src/dsh-client.js";
import { LocalAgentSettingsService, type HostProtocolRequest } from "../plugins/builtin-agents/src/local-agent-settings-service.js";
import type { RuntimeProviderApplyParams, RuntimeSettingsNamespaceView } from "@opencraft/appserver-protocol";

function fixture() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const secrets = new Map([["SHARED_KEY", "original"]]);
  let namespace: RuntimeSettingsNamespaceView = {
    ns: "llm-pi-ai", schema: {}, revision: 7, applies: "live", secrets: [],
    base: { providers: { existing: { baseURL: "https://original.test/v1", apiKeyEnv: "SHARED_KEY", compat: { keep: true } } } },
    user: {}, value: { providers: { existing: { baseURL: "https://original.test/v1", apiKeyEnv: "SHARED_KEY", compat: { keep: true } } } },
  };
  let failure: "none" | "conflict" | "reject" | "unknown" | "lost-response" | "post-commit-rejection" = "none";
  const client = { async call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    calls.push({ method, payload });
    let result: unknown = {};
    if (method === "settings.describe") result = { writable: true, hasDocument: true, namespaces: [namespace] };
    if (method === "llm.providers") result = { providers: [{ provider: "existing", displayName: "Existing", settingsNs: "llm-pi-ai", settingsPath: ["providers", "existing"], active: true }] };
    if (method === "llm.discoverModels") result = { models: [{ id: "catalog-only" }] };
    if (method === "credentials.set") secrets.set(String(payload.ref), String(payload.value));
    if (method === "credentials.unset") secrets.delete(String(payload.ref));
    if (method === "settings.mutate") {
      if (failure === "conflict" || namespace.revision !== payload.expectedRevision) throw new DshClientError("settings-conflict", "changed");
      if (failure === "reject") throw new DshClientError("settings-rejected", "schema rejected");
      if (failure === "unknown") throw new Error("response disconnected");
      const user = structuredClone(namespace.user) as Record<string, any>;
      for (const op of payload.ops as { op: string; path: string[]; value?: unknown }[]) {
        let parent = user;
        for (const key of op.path.slice(0, -1)) parent = parent[key] ??= {};
        if (op.op === "set") parent[op.path.at(-1)!] = op.value;
        else delete parent[op.path.at(-1)!];
      }
      namespace = { ...namespace, user, value: user, revision: namespace.revision + 1 };
      if (failure === "lost-response") throw new Error("lost acknowledgement");
      if (failure === "post-commit-rejection") throw new DshClientError("settings-rejected", "commit listener invariant");
      result = namespace;
    }
    return result as T;
  } };
  return { client, service: new RuntimeProviderService(client), calls, secrets, section: () => namespace, fail: (value: typeof failure) => { failure = value; } };
}
const createInput = (): RuntimeProviderApplyParams => ({
  target: { kind: "create", id: "custom-test" }, expectedRevision: 7,
  displayName: "Test Gateway", baseURL: "https://example.test/deployment/v1/",
  api: "openai-responses", models: [{ id: "test-model" }], credential: { kind: "replace", value: "new-secret" },
});

test("model selection is durable, revision guarded, independent of catalog and credentials", async () => {
  let revision = 1;
  const config: any = { providers: { custom: { enabled: false, models: [{ id: "own" }, { id: "second" }] } }, modelSelection: {} };
  const service = new RuntimeProviderService({ async call<T>(method: string, args: any = {}): Promise<T> {
    if (method === "settings.describe") return { writable: true, namespaces: [
      { ns: "llm-pi-ai", value: structuredClone(config), revision },
      { ns: "agent-default-model", value: { provider: "native", model: "default" } },
    ] } as T;
    if (method === "llm.providers") return { providers: [
      { provider: "native", settingsNs: "llm-native", active: true },
      { provider: "custom", displayName: "Custom", settingsNs: "llm-pi-ai", declared: true, active: false },
    ] } as T;
    if (method === "llm.models") return { groups: [{ id: "native", name: "Native", models: [{ id: "default", name: "Default" }, { id: "other", name: "Other" }] }], failures: [] } as T;
    if (method === "settings.mutate") {
      assert.equal(args.expectedRevision, revision);
      for (const op of args.ops) {
        let target = config;
        for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
        target[op.path.at(-1)] = op.value;
      }
      return { revision: ++revision } as T;
    }
    throw new Error(`Unexpected method ${method}`);
  } });
  await service.mutateModel({ provider: "native", model: "other", expectedRevision: 1 }, false);
  assert.equal((await service.models()).groups[0].models.some(model => model.id === "other"), false);
  assert.equal((await service.models(true)).groups[0].models.find(model => model.id === "other")?.enabled, false);
  assert.deepEqual(config.modelSelection.native, ["other"]);
  await assert.rejects(service.mutateModel({ provider: "native", model: "other", expectedRevision: 1 }, true), /changed/);
  await assert.rejects(service.mutateModel({ provider: "native", model: "default", expectedRevision: 2 }, false), /default model/);
  await assert.rejects(service.mutateModel({ provider: "native", model: "other", expectedRevision: 2 }), /Built-in/);
  await service.mutateModel({ provider: "native", model: "other", expectedRevision: 2 }, true);
  assert.equal((await service.models()).groups[0].models.length, 2);
  await service.mutateModel({ provider: "custom", model: "own", expectedRevision: 3 });
  assert.deepEqual(config.providers.custom.models, [{ id: "second" }]);
  assert.equal((await service.models(true)).groups.find(group => group.id === "custom")?.models.some(model => model.id === "own"), false);
  await service.mutateModel({ provider: "custom", model: "second", expectedRevision: 4 });
  assert.deepEqual(config.providers.custom.models, []);
});

test("capabilities are host supplied; apply stages a new secret and writes runtime-owned paths with CAS", async () => {
  const f = fixture();
  assert.deepEqual((await f.service.list()).creation?.apis, ["openai-completions", "openai-responses"]);
  const result = await f.service.apply(createInput());
  assert.equal(result.saved, true);
  assert.equal(f.secrets.get("SHARED_KEY"), "original");
  const profile = (f.section().user as any).providers["custom-test"];
  assert.equal(profile.baseURL, "https://example.test/deployment/v1");
  assert.equal(profile.api, "openai-responses");
  assert.equal(f.secrets.get(profile.apiKeyEnv), "new-secret");
  assert.equal(JSON.stringify(result).includes("new-secret"), false);
  assert.equal(f.calls.some((call) => call.payload.ns === "agent-default-model"), false);
  assert.equal(f.calls.find((call) => call.method === "settings.mutate")?.payload.expectedRevision, 7);
});

test("update does not materialize effective defaults into user settings", async () => {
  const f = fixture();
  await f.service.apply({ target: { kind: "update", id: "existing" }, expectedRevision: 7,
    baseURL: "https://original.test/v1", credential: { kind: "keep" } });
  assert.deepEqual((f.section().user as any).providers.existing, { baseURL: "https://original.test/v1" });
  assert.equal(f.calls.some((call) => call.method.startsWith("credentials.")), false);
});

test("endpoint change cannot implicitly reuse a credential; explicit confirmation is accepted", async () => {
  const f = fixture();
  const input: RuntimeProviderApplyParams = { target: { kind: "update", id: "existing" }, expectedRevision: 7,
    baseURL: "https://new.test/v1", credential: { kind: "keep" } };
  await assert.rejects(f.service.apply(input), /confirmation/);
  assert.equal(f.calls.some((call) => call.method === "settings.mutate"), false);
  await f.service.apply({ ...input, credential: { kind: "keep", allowEndpointChange: true } });
});

test("prevalidation rejects collision, invalid models, missing fields and stale revisions before staging", async () => {
  for (const input of [
    { ...createInput(), target: { kind: "create", id: "existing" } },
    { ...createInput(), expectedRevision: 6 },
    { ...createInput(), models: [{ id: "same" }, { id: "same" }] },
    { ...createInput(), baseURL: "https://user:secret@example.test/v1" },
    { ...createInput(), displayName: "" },
  ] as RuntimeProviderApplyParams[]) {
    const f = fixture(); await assert.rejects(f.service.apply(input));
    assert.equal(f.calls.some((call) => call.method === "credentials.set"), false);
  }
});

test("incomplete new connections are persisted disabled without inheriting credentials", async () => {
  const f = fixture();
  await f.service.apply({ target: { kind: "create", id: "draft" }, expectedRevision: 7,
    displayName: "Draft", baseURL: "", credential: { kind: "keep" } });
  const profile = (f.section().user as any).providers.draft;
  assert.equal(profile.enabled, false);
  assert.match(profile.apiKeyEnv, /^OPENCRAFT_UNBOUND_/);
  assert.equal(f.calls.some((call) => call.method === "credentials.set"), false);
});

test("direct apply cannot bypass enabling authentication validation", async () => {
  const f = fixture();
  await assert.rejects(f.service.apply({ target: { kind: "update", id: "existing" }, expectedRevision: 7,
    baseURL: "https://original.test/v1", enabled: true, credential: { kind: "none" } }), /authentication/);
  assert.equal(f.calls.some((call) => call.method === "settings.mutate"), false);
});

for (const failure of ["conflict", "reject"] as const) test(`${failure}: remove only uncommitted staged credential, never shared key`, async () => {
  const f = fixture(); f.fail(failure);
  await assert.rejects(f.service.apply(createInput()));
  assert.deepEqual([...f.secrets], [["SHARED_KEY", "original"]]);
});

for (const failure of ["lost-response", "post-commit-rejection"] as const) test(`${failure}: authoritative read reconciles committed config without removing its secret`, async () => {
  const f = fixture(); f.fail(failure);
  assert.equal((await f.service.apply(createInput())).saved, true);
  assert.equal(f.secrets.size, 2);
  assert.equal(f.calls.some((call) => call.method === "credentials.unset"), false);
});

test("unknown outcome preserves staged credential and never automatically resubmits", async () => {
  const f = fixture(); f.fail("unknown");
  await assert.rejects(f.service.apply(createInput()), /outcome is unknown/);
  assert.equal(f.secrets.size, 2);
  assert.equal(f.calls.filter((call) => call.method === "settings.mutate").length, 1);
});

test("concurrent editors cannot both commit against the same revision", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.service.apply(createInput()), f.service.apply({ ...createInput(), target: { kind: "create", id: "second" } })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(f.secrets.size, 2);
});

test("detach overrides inherited binding without deleting its shared credential", async () => {
  const f = fixture();
  await f.service.apply({ target: { kind: "update", id: "existing" }, expectedRevision: 7,
    baseURL: "https://original.test/v1", credential: { kind: "none" } });
  assert.match((f.section().user as any).providers.existing.apiKeyEnv, /^OPENCRAFT_UNBOUND_/);
  assert.deepEqual([...f.secrets], [["SHARED_KEY", "original"]]);
});

test("catalog lookup strips draft credentials and endpoint", async () => {
  const f = fixture();
  const response = await f.service.discover({ source: "catalog", settingsNs: "llm-pi-ai", provider: "openai", baseURL: "https://new.test", apiKey: "never-forward" });
  assert.equal(response.models[0].id, "catalog-only");
  assert.deepEqual(f.calls.at(-1)?.payload, { settingsNs: "llm-pi-ai", provider: "openai" });
});

test("endpoint discovery hits /models even for a catalog provider; preserves prefix and rejects redirects", async () => {
  const requests: { path: string; auth: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, auth: request.headers.authorization });
    if (request.url === "/redirect/models") { response.writeHead(302, { location: "/must-not-follow" }); response.end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "endpoint-only" }, { id: "endpoint-only" }, {}] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const f = fixture();
    const response = await f.service.discover({ source: "endpoint", settingsNs: "llm-pi-ai", provider: "openai", baseURL: `${base}/deployment/v1/`, api: "openai-responses", apiKey: "draft-only" });
    assert.deepEqual(response.models, [{ id: "endpoint-only" }]);
    assert.deepEqual(requests[0], { path: "/deployment/v1/models", auth: "Bearer draft-only" });
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.service.discover({ source: "endpoint", settingsNs: "", baseURL: `${base}/redirect`, api: "openai-completions", apiKey: "secret" }));
    assert.equal(requests.some((request) => request.path === "/must-not-follow"), false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("settings frontend saves through a single application command, never writes credentials", async () => {
  const f = fixture(); const methods: string[] = [];
  const request = (async (_host: string, method: string, params: any) => {
    methods.push(method);
    if (method === "runtime/status/read") return { engineId: "dsh", displayName: "Test", version: "test", cwd: "/tmp", provider: null, model: null };
    if (method === "runtime/providers/list") return f.service.list();
    if (method === "runtime/settings/describe") return f.client.call("settings.describe");
    if (method === "runtime/models/list") return { groups: [], failures: [] };
    if (method === "runtime/providers/apply") return f.service.apply(params);
    throw new Error(`Unexpected frontend call: ${method}`);
  }) as HostProtocolRequest;
  const service = new LocalAgentSettingsService(request);
  await service.refresh();
  const provider = (await f.service.list()).providers[0];
  const editor = service.editor(provider);
  editor.set("draft", value => ({ ...value, baseURL: "https://unsaved.test/v1" }));
  editor.set("dirty", true);
  await service.refresh();
  assert.equal(service.editor(provider), editor, "editor identity survives view reattachment and refresh");
  assert.equal(editor.getSnapshot().draft.baseURL, "https://unsaved.test/v1");
  assert.equal(editor.getSnapshot().baseRevision, 7);
  service.discardEditor(provider.provider);
  assert.equal(service.editor(provider).getSnapshot().dirty, false);
  const input = createInput();
  await service.createProvider(input.target.id, input);
  assert.equal(methods.filter((method) => method === "runtime/providers/apply").length, 1);
  assert.equal(methods.some((method) => method.startsWith("runtime/credentials/")), false);
  service.dispose();
});
