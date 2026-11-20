import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DshModelConfigurationBridge } from "../../apps/local-agent-host/src/model-config/dsh-adapter.js";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../apps/local-agent-host/src/model-config/repository.js";
import { ModelConfigurationService } from "../../apps/local-agent-host/src/model-config/service.js";
import { RuntimeProviderService } from "../../apps/local-agent-host/src/runtime-provider-service.js";
import { LocalAgentSettingsService, type HostProtocolRequest } from "../../plugins/builtin-agents/src/local-agent-settings-service.js";

test("Model directory exposes only OpenAI and Anthropic protocol slots instead of commercial vendor duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-protocol-providers-"));
  try {
    const repository = new ModelConfigurationRepository(directory);
    const credentials = new ModelCredentialRepository(directory);
    let projected = false;
    const dsh = { async call<T>(method: string): Promise<T> {
      if (method === "settings.describe") return { writable: true, hasDocument: true, namespaces: [
        { ns: "llm-pi-ai", revision: 0, schema: {}, base: {}, user: {}, value: {}, secrets: [], applies: "live" },
        { ns: "llm-deepseek", revision: 0, schema: {}, base: {}, user: {}, value: {}, secrets: [], applies: "live" },
        { ns: "agent-default-model", revision: 0, schema: {}, base: {}, user: {}, value: {}, secrets: [], applies: "live" },
      ] } as T;
      if (method === "llm.providers") return { providers: [
        { provider: "deepseek-official", displayName: "DeepSeek", declared: false, settingsNs: "llm-deepseek", settingsPath: [], active: true },
        { provider: "deepseek", displayName: "deepseek", declared: false, settingsNs: "llm-pi-ai", settingsPath: ["providers", "deepseek"], active: false },
        { provider: "groq", displayName: "groq", declared: false, settingsNs: "llm-pi-ai", settingsPath: ["providers", "groq"], active: false },
        ...(projected ? [{ provider: "anthropic-compatible", displayName: "Anthropic 协议", declared: true, settingsNs: "llm-pi-ai", settingsPath: ["providers", "anthropic-compatible"], active: true }] : []),
      ] } as T;
      if (method === "llm.models") return { groups: [], failures: [] } as T;
      throw new Error(`Unexpected DSH request: ${method}`);
    } };
    const config = new ModelConfigurationService(repository, credentials, { apply: async () => { projected = true; } });
    const bridge = new DshModelConfigurationBridge(dsh, config);
    await bridge.initialize();
    const providers = new RuntimeProviderService(bridge);
    const initialList = (await providers.list()).providers;
    assert.deepEqual(initialList.map(provider => provider.provider), ["openai-compatible", "anthropic-compatible"]);
    const openai = initialList.find(provider => provider.provider === "openai-compatible")!;
    const anthropic = initialList.find(provider => provider.provider === "anthropic-compatible")!;
    assert.equal(openai.displayName, "OpenAI 协议");
    assert.equal(openai.declared, false);
    assert.equal(openai.configuration?.defaultApi, "openai-completions");
    assert.equal(openai.configuration?.canUseWithoutAuthentication, true);
    assert.equal(anthropic.displayName, "Anthropic 协议");
    assert.equal(anthropic.declared, false);
    assert.equal(anthropic.configuration?.defaultApi, "anthropic-messages");
    assert.equal(anthropic.configuration?.canUseWithoutAuthentication, false);

    const request = (async (_host, method) => {
      if (method === "runtime/status/read") return {};
      if (method === "runtime/settings/describe") return bridge.call("settings.describe");
      if (method === "runtime/providers/list") return providers.list();
      if (method === "runtime/models/list") return { groups: [], failures: [] };
      throw new Error(`Unexpected Host request: ${method}`);
    }) as HostProtocolRequest;
    const client = new LocalAgentSettingsService(request, "local");
    await client.refresh();
    const draft = client.providerConfiguration(anthropic);
    assert.equal(draft.baseURL, "");
    assert.equal(draft.api, "anthropic-messages");
    assert.equal(draft.credentialRef, "ANTHROPIC_API_KEY");

    await assert.rejects(providers.apply({ target: { kind: "update", id: "anthropic-compatible" }, expectedRevision: 0,
      baseURL: "https://api.anthropic.com/v1", api: "anthropic-messages", models: [{ id: "claude-sonnet-4-5" }],
      credential: { kind: "keep" }, enabled: false,
    }), /移除末尾 \/v1/);

    await providers.apply({ target: { kind: "update", id: "anthropic-compatible" }, expectedRevision: 0,
      baseURL: "https://api.anthropic.com", api: "anthropic-messages", models: [{ id: "claude-sonnet-4-5" }],
      credential: { kind: "keep" }, enabled: false,
    });
    const saved = (await repository.read()).providers[0];
    assert.equal(saved?.id, "anthropic-compatible");
    assert.equal(saved?.catalogId, "anthropic-compatible");
    assert.equal(saved?.name, "Anthropic 协议");
    assert.equal(saved?.baseUrl, "https://api.anthropic.com");
    assert.equal(saved?.protocol, "anthropic-messages");
    assert.equal(saved?.credentialRef, "ANTHROPIC_API_KEY");
    assert.equal(saved?.models[0]?.id, "claude-sonnet-4-5");
    await providers.apply({ target: { kind: "update", id: "anthropic-compatible" }, expectedRevision: 1,
      baseURL: "https://api.anthropic.com", credential: { kind: "replace", value: "synthetic-anthropic-key" },
    });
    assert.notEqual((await repository.read()).providers[0]?.credentialRef, "ANTHROPIC_API_KEY");
    assert.doesNotMatch(await readFile(repository.path, "utf8"), /synthetic-anthropic-key/);
    assert.equal((await providers.list()).providers.find(provider => provider.provider === "anthropic-compatible")?.declared, false);
    client.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
