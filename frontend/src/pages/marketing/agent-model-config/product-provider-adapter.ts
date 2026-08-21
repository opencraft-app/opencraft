import type { IModelProvider } from "@/pages/marketing/agent-config";

import type { HermesCanonicalApiMode, ModelProviderOption } from "./model-config-client";

function decodeHtmlEntity(entity: string) {
  const normalized = entity.toLowerCase();
  if (normalized === "amp") return "&";
  if (normalized === "lt") return "<";
  if (normalized === "gt") return ">";
  if (normalized === "quot") return "\"";
  if (normalized === "apos") return "'";
  if (normalized === "nbsp") return " ";
  if (normalized.startsWith("#x")) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  if (normalized.startsWith("#")) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  return `&${entity};`;
}

function toPlainText(value: string) {
  if (!value) return "";
  return value
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&([a-z0-9#]+);/gi, (_, entity: string) => decodeHtmlEntity(entity))
    .replace(/\s+/g, " ")
    .trim();
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
