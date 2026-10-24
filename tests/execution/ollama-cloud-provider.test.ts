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

test("Ollama Cloud is offered with a working default connection and persists through the normal provider path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ollama-cloud-"));
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
      if (method === "llm.providers") return { providers: projected ? [{
        provider: "ollama-cloud", displayName: "Ollama Cloud", declared: true,
        settingsNs: "llm-pi-ai", settingsPath: ["providers", "ollama-cloud"], active: true,
      }] : [] } as T;
      if (method === "llm.models") return { groups: [], failures: [] } as T;
      throw new Error(`Unexpected DSH request: ${method}`);
    } };
    const config = new ModelConfigurationService(repository, credentials, { apply: async () => { projected = true; } });
    const bridge = new DshModelConfigurationBridge(dsh, config);
    await bridge.initialize();
    const providers = new RuntimeProviderService(bridge);
    const initial = (await providers.list()).providers.find(provider => provider.provider === "ollama-cloud");
    assert.equal(initial?.configured, false);
    assert.equal(initial?.declared, false);
    assert.equal(initial?.configuration?.defaultBaseURL, "https://ollama.com/v1");
    assert.equal(initial?.configuration?.defaultApi, "openai-completions");
    assert.equal(initial?.configuration?.defaultCredentialRef, "OLLAMA_API_KEY");

    const request = (async (_host, method) => {
      if (method === "runtime/status/read") return {};
      if (method === "runtime/settings/describe") return bridge.call("settings.describe");
      if (method === "runtime/providers/list") return providers.list();
      if (method === "runtime/models/list") return { groups: [], failures: [] };
      throw new Error(`Unexpected Host request: ${method}`);
    }) as HostProtocolRequest;
    const client = new LocalAgentSettingsService(request, "local");
    await client.refresh();
    const draft = client.providerConfiguration(initial!);
    assert.equal(draft.baseURL, "https://ollama.com/v1");
    assert.equal(draft.api, "openai-completions");
    assert.equal(draft.credentialRef, "OLLAMA_API_KEY");

    await providers.apply({ target: { kind: "update", id: "ollama-cloud" }, expectedRevision: 0,
      baseURL: draft.baseURL, api: draft.api, models: [{ id: "gpt-oss:20b" }],
      credential: { kind: "keep" }, enabled: false,
    });
    const saved = (await repository.read()).providers[0];
    assert.equal(saved?.id, "ollama-cloud");
    assert.equal(saved?.catalogId, "ollama-cloud");
    assert.equal(saved?.baseUrl, "https://ollama.com/v1");
    assert.equal(saved?.protocol, "openai-completions");
    assert.equal(saved?.credentialRef, "OLLAMA_API_KEY");
    assert.equal(saved?.models[0]?.id, "gpt-oss:20b");
    await providers.apply({ target: { kind: "update", id: "ollama-cloud" }, expectedRevision: 1,
      baseURL: draft.baseURL, credential: { kind: "replace", value: "synthetic-ollama-key" },
    });
    assert.notEqual((await repository.read()).providers[0]?.credentialRef, "OLLAMA_API_KEY");
    assert.doesNotMatch(await readFile(repository.path, "utf8"), /synthetic-ollama-key/);
    assert.equal((await providers.list()).providers.find(provider => provider.provider === "ollama-cloud")?.declared, false);
    client.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
