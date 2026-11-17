import { createEngineModelSource, EngineModelError,
  type ConfiguredProvider, type ConfiguredModel } from "@opencraft/local-agent-host/model-config";
import { CONFIGURED_CODEX_MODEL_PREFIX, type ConfiguredCodexResponses } from "@opencraft/account-pool-host";

export function configuredCodexModelId(providerId: string, modelId: string): string {
  return CONFIGURED_CODEX_MODEL_PREFIX + encodeURIComponent(providerId) + "/" + encodeURIComponent(modelId);
}

/** Codex catalog metadata describes declared capabilities, never guesses from a model name. */
function metadata(provider: ConfiguredProvider, model: ConfiguredModel, defaultEffort?: string): Record<string, unknown> {
  const levels = model.reasoningEfforts && Object.keys(model.reasoningEfforts).filter(level => level !== "off");
  return {
    slug: configuredCodexModelId(provider.id, model.id),
    display_name: `${provider.name} · ${model.name ?? model.id}`,
    description: `${provider.protocol === "anthropic-messages" ? "Anthropic Messages" : "Responses API"} · ${provider.name}`,
    default_reasoning_level: defaultEffort && levels && levels.includes(defaultEffort) ? defaultEffort : null,
    supported_reasoning_levels: (levels || []).map(level => ({ effort: level, description: level })),
    shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 1000,
    additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
    base_instructions: "You are Codex, a coding assistant working with the user in a shared workspace. Use the available tools to carry out the user's task and verify the result.",
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false, supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none", support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10000 }, supports_image_detail_original: false,
    context_window: model.contextWindow ?? null, max_context_window: model.contextWindow ?? null,
    effective_context_window_percent: 95, experimental_supported_tools: [],
    input_modalities: model.input ?? ["text"], supports_search_tool: false,
    supports_experimental_context: false, use_responses_lite: false,
    supports_reasoning_effort_updates: false,
  };
}

function parseConfiguredCodexModelId(id: string): { providerId: string; modelId: string } | null {
  if (!id.startsWith(CONFIGURED_CODEX_MODEL_PREFIX)) return null;
  const parts = id.slice(CONFIGURED_CODEX_MODEL_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  try { return { providerId: decodeURIComponent(parts[0]!), modelId: decodeURIComponent(parts[1]!) }; } catch { return null; }
}

/** Codex projection of the shared engine model source used by every engine adapter. */
export function createConfiguredCodexResponses(directory: string, options: { readonly allowInsecureLocalNetwork?: boolean } = {}): ConfiguredCodexResponses {
  const source = createEngineModelSource(directory, { protocols: ["openai-responses", "anthropic-messages"], allowInsecureLocalNetwork: options.allowInsecureLocalNetwork });
  return {
    async catalog() {
      return (await source.list()).map(route => metadata(route.provider, route.model, route.defaultReasoningEffort));
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
