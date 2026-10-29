import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import messages from "../../apps/workbench-web/src/i18n/locales/zh-CN.json";
import { ModelServicesController } from "../../plugins/builtin-agents/src/model-services/controller";
import { createModelServicesView } from "../../plugins/builtin-agents/src/model-services/view";
import { LocalAgentSettingsService, type HostProtocolRequest } from "../../plugins/builtin-agents/src/local-agent-settings-service";

const renderWithIntl = (element: React.ReactNode) => renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages }, element));

function fixture(discovered: readonly { id: string; input?: readonly ("text" | "image")[]; reasoningEfforts?: false | Record<string, string> }[] = []) {
  const calls: { method: string; params: any }[] = [];
  let revision = 7, config: any = { baseURL: "https://example.invalid/v1", api: "openai-completions", apiKeyEnv: "TEST_REF", models: [{ id: "test-model", input: [] }] };
  const provider = { provider: "test", displayName: "Test", settingsNs: "llm-pi-ai", settingsPath: ["providers", "test"], active: true, configured: true, enabled: true, configuration: { modelDeclarations: true, apis: ["openai-completions"] as const, canProbe: true } };
  const request = (async (_host: string, method: string, params: any) => {
    calls.push({ method, params });
    if (method === "runtime/settings/describe") return { writable: true, namespaces: [{ ns: "llm-pi-ai", revision, value: { providers: { test: config } } }] };
    if (method === "runtime/providers/list") return { providers: [provider] };
    if (method === "runtime/models/list") return { groups: [{ id: "test", models: [{ id: "test-model", name: "Test model" }] }] };
    if (method === "runtime/models/discover") return { models: discovered };
    if (method === "runtime/providers/apply") { if (params.expectedRevision !== revision) throw new Error("settings-conflict"); config = { ...config, baseURL: params.baseURL, ...(params.models ? { models: params.models } : {}), apiKeyEnv: "UPDATED_REF" }; revision++; return { saved: true, revision }; }
    if (method === "runtime/models/probe") return { ok: true, elapsedMs: 1, model: params.model };
    if (method === "runtime/models/check") return { ok: true, elapsedMs: 1, model: params.model };
    if (method === "runtime/credentials/describe") return { credentials: { UPDATED_REF: { configured: true } } };
    return {};
  }) as HostProtocolRequest;
  const service = new LocalAgentSettingsService(request, "test-host");
  return { service, provider, calls, controller: new ModelServicesController(service), externalChange() { revision++; } };
}

test("configured connections collapse without claiming a successful probe; dirty drafts stay open", async () => {
  // The root tsx test runner uses classic JSX for workspace source files.
  Object.assign(globalThis, { React });
  const f = fixture(); await f.service.refresh(); f.controller.select('test');
  const draft = f.controller.draft(f.provider); draft.credentialSet = true;
  const View = createModelServicesView(f.controller);
  const render = () => renderWithIntl(createElement(View, {} as any));
  assert.match(render(), /连接已配置/);
  assert.match(render(), /连接已配置 · 已启用/);
  f.provider.enabled = false;
  f.provider.configuration = { ...f.provider.configuration, canToggle: true } as typeof f.provider.configuration;
  assert.match(render(), /连接已配置 · 未启用/);
  assert.match(render(), /aria-label="启用提供商"/);
  f.provider.enabled = true;
  assert.match(render(), /id="model-service-connection" hidden/);
  assert.doesNotMatch(render(), /model-services__tabs|已收到文本响应/);
  draft.credentialSet = false;
  assert.match(render(), /尚未配置连接/);
  assert.doesNotMatch(render(), /id="model-service-connection" hidden/);
  draft.connectionExpanded = false;
  assert.match(render(), /id="model-service-connection" hidden/, "first-time expansion must still respect explicit collapse");
  draft.connectionExpanded = undefined;
  draft.credentialSet = null;
  assert.match(render(), /凭据状态待确认/);
  assert.doesNotMatch(render(), /连接已配置/);
  draft.credentialSet = true;
  draft.connectionExpanded = true;
  assert.doesNotMatch(render(), /id="model-service-connection" hidden/);
  draft.connectionExpanded = false;
  f.controller.edit(f.provider, {baseURL: 'https://draft.invalid/v1'});
  assert.doesNotMatch(render(), /id="model-service-connection" hidden/);
  f.controller.select(null); f.controller.select('test');
  assert.equal(f.controller.draft(f.provider).config.baseURL, 'https://draft.invalid/v1');
  f.controller.discard(f.provider);
  assert.equal(f.controller.draft(f.provider).dirty, false);
  assert.equal(f.calls.some(call => call.method === 'runtime/providers/apply'), false);
  f.controller.dispose(); f.service.dispose();
});

test("cancel cancels a pending legacy save and restores the saved configuration", async () => {
  const f = fixture(); await f.service.refresh();
  f.controller.edit(f.provider, {baseURL:'https://discard.invalid/v1'});
  f.controller.scheduleSave(f.provider); f.controller.discard(f.provider);
  await new Promise(resolve=>setTimeout(resolve,550));
  assert.equal(f.calls.some(call=>call.method==='runtime/providers/apply'),false);
  assert.equal(f.controller.draft(f.provider).config.baseURL,'https://example.invalid/v1');
  f.controller.dispose(); f.service.dispose();
});

test("provider changes retain CAS baseline and endpoint changes discard the in-memory test key", async () => {
  const f = fixture(); await f.service.refresh();
  f.controller.edit(f.provider, {}, "synthetic");
  f.externalChange(); await f.service.refresh();
  assert.equal(f.controller.draft(f.provider).revision, 7);
  await f.controller.save(f.provider);
  assert.equal(f.controller.error, "settings-conflict");
  assert.equal(f.controller.draft(f.provider).dirty, true);
  f.controller.edit(f.provider, { baseURL: "https://new.invalid/v1" });
  assert.equal(f.controller.draft(f.provider).key, "");
  f.controller.dispose(); f.service.dispose();
});

test("optional DSH modality defaults normalize in the client without changing stored data", async () => {
  const f = fixture(); await f.service.refresh();
  assert.equal(f.service.providerConfiguration(f.provider).models[0]?.input, undefined);
  assert.deepEqual((f.service.getSnapshot().settings?.namespaces[0]?.value as any).providers.test.models[0].input, []);
  f.controller.dispose(); f.service.dispose();
});

test("check requires an explicit save and sends only saved connection identity, not a key", async () => {
  const f = fixture(); await f.service.refresh();
  f.controller.edit(f.provider, {}, "synthetic");
  await f.controller.test(f.provider, "test-model");
  assert.match(f.controller.error??'',/先保存/);
  assert.equal(f.calls.some(c=>c.method==='runtime/providers/apply'||c.method==='runtime/models/check'),false);
  await f.controller.save(f.provider);
  assert.equal(f.controller.draft(f.provider).key,'');
  await f.controller.test(f.provider, "test-model");
  assert.equal(f.calls.filter(call => call.method === "runtime/providers/apply").length, 1);
  assert.equal(f.calls.find(call => call.method === "runtime/providers/apply")!.params.models, undefined, "a key-only save must not override a native provider catalog");
  assert.equal(f.calls.filter(call => call.method === "runtime/models/probe").length, 0);
  assert.deepEqual(f.calls.find(call=>call.method==='runtime/models/check')?.params,{provider:'test',model:'test-model',expectedRevision:8});
  assert.equal(f.controller.draft(f.provider).config.credentialRef, "UPDATED_REF");
  assert.equal(f.controller.draft(f.provider).probe?.ok, true);
  f.controller.edit(f.provider, {}, "another-synthetic");
  assert.equal(f.controller.draft(f.provider).probe, null);
  f.controller.dispose(); f.service.dispose();
});

test("custom model image capability is explicit, reversible, and saved through the provider CAS", async () => {
  const f = fixture(); await f.service.refresh();
  await f.controller.setModelImageInput(f.provider, "test-model", true);
  assert.equal(f.controller.error, null);
  assert.deepEqual(f.calls.filter(call => call.method === "runtime/providers/apply").at(-1)?.params.models, [
    { id: "test-model", input: ["text", "image"] },
  ]);
  assert.deepEqual(f.service.providerConfiguration(f.provider).models[0]?.input, ["text", "image"]);

  await f.controller.setModelImageInput(f.provider, "test-model", false);
  assert.equal(f.controller.error, null);
  assert.deepEqual(f.calls.filter(call => call.method === "runtime/providers/apply").at(-1)?.params.models, [
    { id: "test-model", input: ["text"] },
  ]);
  assert.deepEqual(f.service.providerConfiguration(f.provider).models[0]?.input, ["text"]);
  f.controller.dispose(); f.service.dispose();
});

test("fetching models fills missing image metadata without overwriting an explicit text-only choice", async () => {
  const f = fixture([{ id: "test-model", input: ["text", "image"] }]);
  await f.service.refresh();
  await f.controller.fetchModels(f.provider);
  assert.deepEqual(f.service.providerConfiguration(f.provider).models[0]?.input, ["text", "image"]);
  await f.controller.setModelImageInput(f.provider, "test-model", false);
  await f.controller.fetchModels(f.provider);
  assert.deepEqual(f.service.providerConfiguration(f.provider).models[0]?.input, ["text"]);
  f.controller.dispose(); f.service.dispose();
});

test("fetching models fills missing thinking levels without replacing a user's explicit choice", async () => {
  const f = fixture([{ id: "test-model", reasoningEfforts: { low: "low", high: "high", max: "max" } }]);
  await f.service.refresh();
  await f.controller.fetchModels(f.provider);
  assert.deepEqual(f.service.providerConfiguration(f.provider).models[0]?.reasoningEfforts, { low: "low", high: "high", max: "max" });
  await f.controller.setModelReasoningLevel(f.provider, "test-model", "max", false);
  await f.controller.fetchModels(f.provider);
  assert.deepEqual(f.service.providerConfiguration(f.provider).models[0]?.reasoningEfforts, { low: "low", high: "high" });
  f.controller.dispose(); f.service.dispose();
});

test("model settings show discovered thinking levels beside the corresponding model", async () => {
  Object.assign(globalThis, { React });
  const f = fixture([{ id: "test-model", reasoningEfforts: { low: "low", high: "high", max: "max" } }]);
  await f.service.refresh(); f.controller.select("test");
  await f.controller.fetchModels(f.provider);
  const View = createModelServicesView(f.controller);
  const markup = renderWithIntl(createElement(View, {} as any));
  assert.match(markup, /思考档位：低、高、最高/u);
  assert.match(markup, /aria-label="模型操作：test-model"/u);
  f.controller.dispose(); f.service.dispose();
});

test("model capability mutation stays row-scoped while its request is pending", async () => {
  const f = fixture(); await f.service.refresh();
  const draft = f.controller.draft(f.provider);
  draft.connectionExpanded = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const originalSave = f.service.saveProvider.bind(f.service);
  f.service.saveProvider = async (...args) => { await held; return originalSave(...args); };

  const saving = f.controller.setModelImageInput(f.provider, "test-model", true);
  assert.equal(f.controller.isModelCapabilityPending("test", "test-model"), true);
  assert.equal(draft.dirty, false, "a row mutation must not dirty the connection form");
  assert.equal(draft.connectionExpanded, false, "a row mutation must not expand the connection form");
  assert.equal(f.controller.busy, false, "a row mutation must not claim the page-wide busy state");

  release(); await saving;
  assert.equal(f.controller.isModelCapabilityPending("test", "test-model"), false);
  assert.equal(f.controller.error, null);
  f.controller.dispose(); f.service.dispose();
});

test("disposing the page service cancels pending autosave", async () => {
  const f = fixture(); await f.service.refresh();
  f.controller.edit(f.provider, {}, "synthetic"); f.controller.scheduleSave(f.provider); f.controller.dispose();
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(f.calls.some(call => call.method === "runtime/providers/apply"), false);
  f.service.dispose();
});

test("loading providers uses only an accessible in-place pending icon", () => {
  Object.assign(globalThis, { React });
  const request = (() => new Promise(() => undefined)) as HostProtocolRequest;
  const service = new LocalAgentSettingsService(request, "local");
  const controller = new ModelServicesController(service);
  void service.refresh();
  const View = createModelServicesView(controller);
  const markup = renderWithIntl(createElement(View, {} as any));
  assert.match(markup, /model-services__pending/u);
  assert.match(markup, /role="status" aria-label="正在加载提供商"/u);
  assert.doesNotMatch(markup, />正在加载提供商/u);
  controller.dispose();
  service.dispose();
});
