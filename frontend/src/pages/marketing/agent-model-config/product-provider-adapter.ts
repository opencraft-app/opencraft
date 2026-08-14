import type { IModelProvider } from "@tencent/tea-sdk-lightclaw";

import type { HermesCanonicalApiMode, ModelProviderOption } from "./model-config-client";

function toPlainText(value: string) {
  if (!value) return "";
  if (typeof document !== "undefined") {
    const container = document.createElement("div");
    container.innerHTML = value;
    return (container.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function toHermesApiMode(value: string): HermesCanonicalApiMode | null {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (["openai", "openai_chat", "openai_completions", "chat_completions"].includes(normalized)) {
    return "chat_completions";
  }
  if (["anthropic", "anthropic_messages"].includes(normalized)) return "anthropic_messages";
  if (["bedrock", "bedrock_converse"].includes(normalized)) return "bedrock_converse";
  if (["codex", "codex_responses", "openai_codex_responses", "openai_responses", "responses"].includes(normalized)) {
    return "codex_responses";
  }
  return null;
}

export function adaptProductModelProviders(source: IModelProvider[] | undefined): ModelProviderOption[] {
  return (source ?? []).flatMap((provider) => {
    const baseUrl = provider.base_url.trim();
    const apiMode = toHermesApiMode(provider.api);
    if (!baseUrl || provider.oauth?.exclusive || !apiMode) return [];
    return [{
      providerKey: provider.value,
      providerName: toPlainText(provider.provider_name) || provider.provider || provider.value,
      category: provider.category,
      baseUrl,
      apiMode,
      description: toPlainText(provider.description) || undefined,
      apiKeyUrl: provider.api_key_url.trim() || undefined,
      catalogModels: provider.models
        .map((model) => ({ id: model.id.trim(), name: model.name.trim() || model.id.trim() }))
        .filter((model) => model.id),
    } satisfies ModelProviderOption];
  });
}

export function resolveProductModelProviderOptions(
  productConfig: {
    modelProviders?: IModelProvider[];
    getFilteredModelProviders?: (region?: string, regionId?: number) => IModelProvider[];
  },
  liveProviders: IModelProvider[] | undefined,
  instance: { region?: string; regionId?: number } = {},
) {
  const region = instance.region ?? (instance.regionId === 5 ? "ap-hongkong" : undefined);
  const source = productConfig.getFilteredModelProviders?.(region, instance.regionId)
    ?? productConfig.modelProviders
    ?? liveProviders
    ?? [];
  return adaptProductModelProviders(source);
}
