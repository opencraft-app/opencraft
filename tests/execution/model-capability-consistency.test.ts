import assert from "node:assert/strict";
import test from "node:test";
import { projectComposerModelChoices, resolveComposerModelChoice } from "@opencraft/workbench-runtime";
import { DshAppServerAdapter } from "../../apps/local-agent-host/src/dsh-appserver-adapter.js";
import { DshModelEngineAdapter } from "../../apps/local-agent-host/src/model-config/dsh-adapter.js";
import { emptyModelDocument } from "../../apps/local-agent-host/src/model-config/model-document.js";
import { compileSubmitIntent, SubmitCompileError } from "@opencraft/composer-appserver";
import type { SubmitIntent } from "@opencraft/composer-core";

function fixture(defaultModel: { provider: string; model: string } | null = null, productOwned = false, currentModel = "text") {
  const catalog = { groups: [{ id: "custom", name: "Custom", models: [
    { id: "text", name: "Text", input: ["text"], contextWindow: 32768, maxTokens: 4096 },
    { id: "vision", name: "Vision", input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
    { id: "unknown", name: "Unknown" },
  ] }], failures: [] };
  const client = { call: async (method: string) => {
    if (method === "llm.models") return catalog;
    if (method === "llm.providers") return { providers: [] };
    if (method === "session.models") return { ...catalog, current: { provider: "custom", model: currentModel }, routable: true };
    if (method === "settings.describe") return { namespaces: [
      { ns: "llm-pi-ai", value: {} }, { ns: "agent-default-model", value: defaultModel ?? {} },
    ] };
    if (method === "settings.mutate") return {};
    throw new Error("Unexpected method " + method);
  } };
  return new DshAppServerAdapter(client as any, productOwned ? client as any : undefined);
}

test("catalog defaults come from explicit settings, never directory order", async () => {
  for (const selection of [null, { provider: "custom", model: "vision" }]) {
    const adapter = fixture(selection);
    try {
      const result = await adapter.dispatch("model/list", {}) as any;
      assert.deepEqual(result.data.filter((model: any) => model.isDefault).map((model: any) => model.displayName), selection ? ["Vision"] : []);
      const choices = projectComposerModelChoices(result.data);
      assert.equal(resolveComposerModelChoice(choices, undefined)?.label ?? null, selection ? "Vision" : null);
      assert.equal(resolveComposerModelChoice(choices, "dsh-model:custom:text")?.label, "Text");
      assert.equal(resolveComposerModelChoice(choices, "missing"), null, "a stale explicit selection must not silently change models");
    } finally { adapter.close(); }
  }
});
test("compiler rejects remote and local images for a text model before sending", () => {
  for (const uri of ["file:///tmp/never-read.png", "data:image/png;base64,synthetic"]) {
    const intent: SubmitIntent = { commandId: "input-test", clientMessageId: "input-message", target: { type: "new-thread", hostId: "local" } as any,
      document: { version: 1, blocks: [] }, context: [], selections: { model: "text" }, options: { autoContext: false }, createdAt: 0,
      attachments: [{ id: "image", name: "Image", mimeType: "image/png", size: 1, uri, lifecycle: "ready" } as any] };
    assert.throws(() => compileSubmitIntent(intent, { inputModalities: ["text"] }), error => error instanceof SubmitCompileError && error.code === "UNSUPPORTED_INPUT");
    assert.equal(compileSubmitIntent(intent, { inputModalities: ["text", "image"] }).input.length, 1);
  }
});
test("input capabilities are projected from the model, with unknown input conservative", async () => {
  const adapter = fixture();
  try {
    const result = await adapter.dispatch("model/list", {}) as any;
    assert.deepEqual(result.data.map((model: any) => model.inputModalities), [["text"], ["text", "image"], ["text"]]);
    assert.deepEqual(result.data.slice(0, 2).map((model: any) => [model.contextWindow, model.maxTokens]), [[32768, 4096], [128000, 16384]]);
    const choices = projectComposerModelChoices(result.data);
    assert.deepEqual(choices.slice(0, 2).map(model => [model.contextWindow, model.maxTokens]), [[32768, 4096], [128000, 16384]]);
  } finally { adapter.close(); }
});
test("composer choices preserve user-authored custom model metadata", () => {
  const [choice] = projectComposerModelChoices([{
    id: "custom-vision",
    model: "custom-vision",
    displayName: "My Vision Model",
    description: "not rendered by the compact picker",
    hidden: false,
    isDefault: false,
    inputModalities: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    source: "custom",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  } as any]);
  assert.deepEqual(choice && {
    label: choice.label,
    inputModalities: choice.inputModalities,
    contextWindow: choice.contextWindow,
    maxTokens: choice.maxTokens,
    source: choice.source,
  }, {
    label: "My Vision Model",
    inputModalities: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    source: "custom",
  });
});
test("the native resolved model capability takes precedence over stale catalog metadata", async () => {
  const adapter = fixture();
  adapter.setModelInfoReader(async (_provider, model) => ({ input: model === "unknown" ? ["text", "image"] : ["text"] }));
  try {
    const result = await adapter.dispatch("model/list", {}) as any;
    assert.deepEqual(result.data.map((model: any) => model.inputModalities), [["text"], ["text"], ["text", "image"]]);
  } finally { adapter.close(); }
});
test("Host reasoning levels remain selectable in the Composer model catalog", async () => {
  const adapter = fixture();
  adapter.setModelInfoReader(async (_provider, model) => ({
    reasoning: model === "vision" ? { efforts: [
      { id: "low", name: "Low" }, { id: "high", name: "High" }, { id: "max", name: "Max" },
    ] } : null,
  }));
  try {
    const response = await adapter.dispatch("model/list", {}) as any;
    const model = response.data.find((entry: any) => entry.displayName === "Vision");
    assert.deepEqual(model?.supportedReasoningEfforts.map((effort: any) => effort.reasoningEffort), ["low", "high", "max"]);
    const choice = projectComposerModelChoices(response.data).find(item => item.label === "Vision");
    assert.deepEqual(choice?.efforts.map(effort => effort.value), ["low", "high", "max"]);
  } finally { adapter.close(); }
});
test("an unknown native capability falls back to the explicit custom model declaration", async () => {
  const adapter = fixture(null, false, "vision");
  adapter.setModelInfoReader(async () => ({ input: null }));
  try {
    const result = await adapter.dispatch("model/list", {}) as any;
    assert.deepEqual(result.data.find((model: any) => model.displayName === "Vision")?.inputModalities, ["text", "image"]);
    await (adapter as any).assertInput("existing", [{ type: "image", url: "data:image/png;base64,synthetic" }]);
  } finally { adapter.close(); }
});
test("clearing the product default removes the adapter's old engine selection", async () => {
  const writes: any[] = [];
  const adapter = new DshModelEngineAdapter({ call: async (method: string, params: any) => {
    if (method === "settings.describe") return { namespaces: [{ ns: "agent-default-model", revision: 3,
      base: { provider: "private", model: "private" }, value: { provider: "old", model: "old", reasoningEffort: "high" } }] } as any;
    if (method === "settings.mutate") { writes.push(params); return {} as any; }
    throw new Error("Unexpected " + method);
  } });
  await adapter.apply(emptyModelDocument(), { resolve: async () => undefined });
  assert.deepEqual(writes, [{ ns: "agent-default-model", expectedRevision: 3, ops: [
    { op: "unset", path: ["provider"] }, { op: "unset", path: ["model"] }, { op: "unset", path: ["reasoningEffort"] },
  ] }]);
});
test("a new thread without explicit selection or default is rejected before engine creation", async () => {
  const adapter = fixture(); let creations = 0;
  adapter.setThreadEngine({ create: async () => { creations++; throw new Error("must not create"); },
    resume: async () => {}, fork: async () => {}, inject: async () => {}, release: async () => {} });
  try {
    await assert.rejects(adapter.dispatch("thread/start", {}), /请先选择模型/);
    assert.equal(creations, 0);
  } finally { adapter.close(); }
});
test("Host rejects an unsupported local image before reading it or prompting the engine", async () => {
  const adapter = fixture();
  try {
    await assert.rejects(adapter.dispatch("turn/start", { threadId: "existing", input: [{ type: "localImage", path: "/tmp/opencraft-image-must-not-be-read.png" }] }), /不支持 image 输入/);
  } finally { adapter.close(); }
});
test("product-owned default can be cleared as one complete mutation, not a partial selection", async () => {
  const adapter = fixture({ provider: "custom", model: "vision" }, true);
  try {
    await adapter.dispatch("runtime/settings/mutate", { ns: "agent-default-model", expectedRevision: 1, ops: [
      { op: "unset", path: ["provider"] }, { op: "unset", path: ["model"] }, { op: "unset", path: ["reasoningEffort"] },
    ] });
    await assert.rejects(adapter.dispatch("runtime/settings/mutate", { ns: "agent-default-model", expectedRevision: 1, ops: [
      { op: "unset", path: ["provider"] },
    ] }), /Default model must/);
  } finally { adapter.close(); }
});
test("default settings cannot persist a reasoning effort the model does not support", async () => {
  const adapter = fixture({ provider: "custom", model: "text" }, true);
  try {
    await assert.rejects(adapter.dispatch("runtime/settings/mutate", { ns: "agent-default-model", expectedRevision: 1,
      ops: [{ op: "set", path: ["reasoningEffort"], value: "none" }] }), /does not support reasoning effort/);
  } finally { adapter.close(); }
});

test("speed tiers are projected only from model service capabilities", () => {
  const model = { id: "speed", model: "speed", displayName: "Speed", hidden: false, description: "", isDefault: true,
    supportedReasoningEfforts: [], defaultReasoningEffort: null, serviceTiers: [{ id: "fast", name: "Fast", description: "Server description" }] };
  assert.deepEqual(projectComposerModelChoices([model as any])[0]?.serviceTiers, model.serviceTiers);
  assert.deepEqual(projectComposerModelChoices([{ ...model, serviceTiers: [] } as any])[0]?.serviceTiers, []);
  assert.deepEqual(projectComposerModelChoices([{ ...model, serviceTiers: [], additionalSpeedTiers: ["fast"] } as any])[0]?.serviceTiers, [{ id: "fast", name: "Fast", description: "" }]);
});
