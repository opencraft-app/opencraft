import { createEngineModelSource, EngineModelError } from "@opencraft/local-agent-host/model-config";
import { codexModelMetadata } from "@opencraft/account-pool-host/codex-model-catalog";
import { CONFIGURED_CODEX_MODEL_PREFIX, type ConfiguredCodexResponses } from "@opencraft/account-pool-host";

export function configuredCodexModelId(providerId: string, modelId: string): string {
  return CONFIGURED_CODEX_MODEL_PREFIX + encodeURIComponent(providerId) + "/" + encodeURIComponent(modelId);
}

function parseConfiguredCodexModelId(id: string): { providerId: string; modelId: string } | null {
  if (!id.startsWith(CONFIGURED_CODEX_MODEL_PREFIX)) return null;
  const parts = id.slice(CONFIGURED_CODEX_MODEL_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  try { return { providerId: decodeURIComponent(parts[0]!), modelId: decodeURIComponent(parts[1]!) }; } catch { return null; }
}

/** Codex projection of the shared engine model source used by every engine adapter. */
export function createConfiguredCodexResponses(directory: string, options: { readonly allowInsecureLocalNetwork?: boolean } = {}): ConfiguredCodexResponses {
  // Chat Completions connections resolve only for engine provider passthrough; Codex lists and uses Responses/Messages.
  const source = createEngineModelSource(directory, { protocols: ["openai-responses", "anthropic-messages", "openai-completions"], allowInsecureLocalNetwork: options.allowInsecureLocalNetwork, meteredContributions: true });
  return {
    async catalog() {
      return (await source.list()).filter(route => route.protocol !== "openai-completions")
        .map(route => codexModelMetadata(configuredCodexModelId(route.provider.id, route.model.id),
          route.provider, route.model, route.defaultReasoningEffort));
    },
    async resolve(id) {
      const reference = parseConfiguredCodexModelId(id);
      if (!reference || configuredCodexModelId(reference.providerId, reference.modelId) !== id) return null;
      try {
        const route = await source.resolve(reference);
        return { baseUrl: route.baseUrl, model: route.model.id, apiKey: route.apiKey, reasoningEfforts: route.model.reasoningEfforts,
          protocol: route.protocol, maxTokens: route.model.maxTokens };
      } catch (error) {
        if (error instanceof EngineModelError && error.code === "unavailable") return null;
        throw error;
      }
    },
  };
}
