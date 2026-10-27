import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { RuntimeProviderService } from "../../apps/local-agent-host/src/runtime-provider-service.js";
import { DshClientError } from "../../apps/local-agent-host/src/dsh-client.js";
import { LocalAgentSettingsService, type HostProtocolRequest } from "../../plugins/builtin-agents/src/local-agent-settings-service.js";
import { modelBaseUrlError } from "@opencraft/appserver-protocol";
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

test("base URL validation preserves prefixes and rejects operation URLs before secret or network writes",async()=>{
  for(const path of ['/v1/chat/completions','/v1/chat/completions/','/v1/responses','/v1/models']){
    const baseURL=`https://example.test${path}`;
    assert.match(modelBaseUrlError(baseURL)??'',/基础地址/);
    const f=fixture();await assert.rejects(f.service.apply({...createInput(),baseURL}),/基础地址/);
    await assert.rejects(f.service.probe({baseURL,api:'openai-completions',model:'test'}),/基础地址/);
    await assert.rejects(f.service.discover({source:'endpoint',settingsNs:'',baseURL,api:'openai-completions'}),/基础地址/);
    assert.equal(f.calls.some(c=>c.method==='credentials.set'||c.method==='settings.mutate'),false);
  }
  for(const value of ['','https://example.test','https://example.test/v1/','https://example.test/gateway/openai/deployments/custom'])assert.equal(modelBaseUrlError(value),null);
});

test("deleting custom providers checks identity, revision and defaults without touching credentials", async () => {
  for (const scenario of ['allowed','builtin','default','stale','readonly','invalid-path']) {
    const calls: {method:string;payload:any}[] = [];
    const client = {call: async <T>(method:string,payload:any={}) => {
      calls.push({method,payload});
      if (method==='llm.providers') return {providers:[{provider:'custom-demo',declared:scenario!=='builtin',settingsNs:'llm-pi-ai',settingsPath:scenario==='invalid-path'?['providers','other']:['providers','custom-demo']}]} as T;
      if (method==='settings.describe') return {writable:scenario!=='readonly',namespaces:[
        {ns:'llm-pi-ai',revision:7,value:{providers:{'custom-demo':{apiKeyEnv:'SHARED_KEY'}},modelSelection:{'custom-demo':['m'],'other':['kept']}}},
        {ns:'agent-default-model',value:{provider:scenario==='default'?'custom-demo':'other',model:'m'}},
      ]} as T;
      return {revision:8} as T;
    }};
    const removal=new RuntimeProviderService(client).remove({provider:'custom-demo',expectedRevision:scenario==='stale'?6:7});
    if(scenario==='allowed') {
      await removal;
      assert.deepEqual(calls.find(call=>call.method==='settings.mutate')?.payload,{ns:'llm-pi-ai',expectedRevision:7,ops:[{op:'unset',path:['providers','custom-demo']},{op:'unset',path:['modelSelection','custom-demo']}]});
    } else {await assert.rejects(removal);assert.equal(calls.some(call=>call.method==='settings.mutate'),false);}
    assert.equal(calls.some(call=>call.method.startsWith('credentials.')),false);
  }
});

test("explicit complete creation enables in one CAS write, legacy creation stays disabled", async () => {
  const f = fixture();
  await f.service.apply({ ...createInput(), enabled: true });
  assert.equal((f.section().user as any).providers["custom-test"].enabled, true);
  assert.equal(f.calls.filter(call => call.method === "settings.mutate").length, 1);
  const legacy = fixture();
  await legacy.service.apply(createInput());
  assert.equal((legacy.section().user as any).providers["custom-test"].enabled, false);
  for (const patch of [{ models: [] }, { baseURL: "" }, { api: undefined }, { credential: { kind: "keep" } }, { enabled: "true" }]) {
    const invalid = fixture();
    await assert.rejects(invalid.service.apply({ ...createInput(), enabled: true, ...patch } as RuntimeProviderApplyParams));
    assert.equal(invalid.calls.some(call => call.method === "credentials.set" || call.method === "settings.mutate"), false);
  }
});

test("discovery imports new model declarations disabled in the same CAS command", async () => {
  const f = fixture();
  await f.service.apply({ ...createInput(), models: [{ id: "discovered" }], disableNewModels: true });
  assert.deepEqual((f.section().user as any).modelSelection["custom-test"], ["discovered"]);
  assert.equal(f.calls.filter(call => call.method === "settings.mutate").length, 1);
});

test("model declarations preserve supported metadata and reject inconsistent capabilities before writes", async () => {
  const f = fixture();
  await f.service.apply({ ...createInput(), models: [{ id: "shared-model", name: "My model", contextWindow: 32768, maxTokens: 4096, input: ["text", "image"] }] });
  assert.deepEqual((f.section().user as any).providers["custom-test"].models[0],
    { id: "shared-model", name: "My model", contextWindow: 32768, maxTokens: 4096, input: ["text", "image"] });
  for (const models of [[{ id: "bad", contextWindow: 100, maxTokens: 200 }], [{ id: "bad", input: ["audio"] }], [{ id: "bad", name: " " }], [{ id: "bad", reasoningEfforts: { off: null } }]]) {
    const invalid = fixture();
    await assert.rejects(invalid.service.apply({ ...createInput(), models: models as any }));
    assert.equal(invalid.calls.some(call => call.method === "credentials.set" || call.method === "settings.mutate"), false);
  }
});


test("environment model settings never fall back to the active or local Host", async () => {
  const hosts: string[] = [];
  const request = (async (host: string, method: string) => {
    hosts.push(host);
    if (method === "runtime/credentials/describe") return { credentials: {} };
    if (method === "runtime/models/probe") return { ok: true, model: "same", elapsedMs: 1 };
    if (method === "runtime/models/discover") return { models: [] };
    return { providers: [], groups: [], namespaces: [], writable: true };
  }) as HostProtocolRequest;
  const remote = new LocalAgentSettingsService(request, "remote-test");
  await remote.refresh(); await remote.describeCredential("TEST_REF");
  await remote.discoverModels(null, { baseURL: "http://127.0.0.1/v1", api: "openai-completions", credential: { kind: "none" } }, "endpoint");
  await remote.probeModel({ baseURL: "http://127.0.0.1/v1", api: "openai-completions", credential: { kind: "none" } }, "same");
  assert.ok(hosts.length >= 7); assert.ok(hosts.every(host => host === "remote-test"));
  await assert.rejects(remote.probeModel({ baseURL: "https://example.invalid", api: "openai-completions", credential: { kind: "keep" } }, "same"), /test key/);
  assert.throws(() => new LocalAgentSettingsService(request, ""), /environment/);
  remote.dispose();
});


test("draft inference probes use the selected wire format without reading persisted credentials or changing settings", async () => {
  const requests: { path?: string; body: any; authenticated: boolean }[] = [];
  const endpoint = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url, body: JSON.parse(body), authenticated: request.headers.authorization === "Bearer synthetic-probe-key" });
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/failure")) { response.statusCode = 401; response.end("synthetic-probe-key must never be echoed"); return; }
      if (request.url?.startsWith("/redirect")) { response.statusCode = 302; response.setHeader("location", "/unexpected"); response.end(); return; }
      if (request.url?.startsWith("/invalid")) { response.end(JSON.stringify({ data: [] })); return; }
      response.end(JSON.stringify(request.url?.endsWith("/responses")
        ? { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }
        : { choices: [{ message: { role: "assistant", content: "OK" } }] }));
    });
  });
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
  const service = new RuntimeProviderService({ call: async () => { throw new Error("Probe must not access DSH settings or credentials"); } });
  try {
    for (const api of ["openai-completions", "openai-responses"] as const) {
      const result = await service.probe({ baseURL: `${origin}/deployment/v1`, api, model: "test-model", apiKey: "synthetic-probe-key" });
      assert.equal(result.ok, true); assert.equal(JSON.stringify(result).includes("synthetic-probe-key"), false);
    }
    assert.deepEqual(requests.map(row => row.path), ["/deployment/v1/chat/completions", "/deployment/v1/responses"]);
    assert.ok(requests.every(row => row.authenticated && row.body.model === "test-model" && row.body.stream === false));
    for (const path of ["failure", "redirect", "invalid"]) {
      const result = await service.probe({ baseURL: `${origin}/${path}`, api: "openai-completions", model: "test", apiKey: "synthetic-probe-key" });
      assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("synthetic-probe-key"), false);
    }
    assert.equal(requests.some(row => row.path === "/unexpected"), false);
    await assert.rejects(service.probe({ baseURL: "https://user:password@example.invalid", api: "openai-completions", model: "test" }), /without credentials/);
  } finally { await new Promise<void>(resolve => endpoint.close(() => resolve())); }
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

test("an empty model connection cannot be enabled or leave a saved failed engine state", async () => {
  const f = fixture();
  await assert.rejects(f.service.apply({ target: { kind: "update", id: "existing" }, expectedRevision: 7,
    baseURL: "https://original.test/v1", enabled: true, credential: { kind: "replace", value: "synthetic-key" } }), /先获取模型，并启用至少一个模型/);
  assert.equal(f.calls.some(call => call.method === "settings.mutate"), false);
  assert.equal(f.calls.some(call => call.method === "credentials.set"), false);
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

test("Ollama Cloud discovery uses its show API to declare image input without forwarding the draft key", async () => {
  const requests: { path: string; auth: string | undefined; model?: string }[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      requests.push({ path: request.url, auth: request.headers.authorization });
      response.end(JSON.stringify({ data: [{ id: "vision-model" }, { id: "text-model" }, { id: "metadata-unavailable" }] }));
      return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model as string;
    requests.push({ path: request.url!, auth: request.headers.authorization, model });
    if (model === "metadata-unavailable") { response.statusCode = 503; response.end("{}"); return; }
    response.end(JSON.stringify({
      capabilities: model === "vision-model" ? ["completion", "vision", "thinking"] : ["completion", "thinking"],
      thinking: model === "vision-model"
        ? { values: [false, "low", "high", "max"], default: "high" }
        : { values: ["low", "high"], default: "low" },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const result = await fixture().service.discover({ source: "endpoint", settingsNs: "llm-pi-ai", provider: "ollama-cloud", baseURL, api: "openai-completions", apiKey: "synthetic-draft-key" });
    assert.deepEqual(result.models, [
      { id: "vision-model", input: ["text", "image"], reasoningEfforts: { low: "low", high: "high", max: "max" } },
      { id: "text-model", reasoningEfforts: { low: "low", high: "high" } },
      { id: "metadata-unavailable" },
    ]);
    assert.equal(requests.find(row => row.path === "/v1/models")?.auth, "Bearer synthetic-draft-key");
    assert.equal(requests.filter(row => row.path === "/api/show").length, 3);
    assert.ok(requests.filter(row => row.path === "/api/show").every(row => row.auth === undefined));
    requests.length = 0;
    await fixture().service.discover({ source: "endpoint", settingsNs: "llm-pi-ai", provider: "other", baseURL, api: "openai-completions" });
    assert.deepEqual(requests.map(row => row.path), ["/v1/models"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
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
  const service = new LocalAgentSettingsService(request, "local");
  await service.refresh();
  const input = createInput();
  await service.createProvider(input.target.id, input);
  assert.equal(methods.filter((method) => method === "runtime/providers/apply").length, 1);
  assert.equal(methods.some((method) => method.startsWith("runtime/credentials/")), false);
  service.dispose();
});
