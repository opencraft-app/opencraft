// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { IModelProvider } from "../agent-config/utils/model-providers";

import type { HermesCanonicalApiMode, ModelProviderOption } from "./model-config-client";

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

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
    if (!provider || !["coding_plan", "api"].includes(provider.category)) return [];
    const providerKey = readString(provider.value).trim();
    const providerId = readString(provider.provider).trim();
    const baseUrl = readString(provider.base_url).trim();
    const apiMode = toHermesApiMode(readString(provider.api));
    if (!providerKey || !baseUrl || provider.oauth?.exclusive || !apiMode) return [];
    const isCodingPlan = provider.category === "coding_plan";
    const catalogModels = (Array.isArray(provider.models) ? provider.models : []).flatMap((model) => {
      if (!model || typeof model.id !== "string") return [];
      const id = model.id.trim();
      if (!id) return [];
      const name = typeof model.name === "string" ? model.name.trim() : "";
      return [{ id, name: name || id }];
    });
    if (isCodingPlan && catalogModels.length === 0) return [];
    return [{
      providerKey,
      providerName: toPlainText(readString(provider.provider_name)) || providerId || providerKey,
      category: provider.category,
      baseUrl,
      apiMode,
      discoveryStrategy: "catalog",
      ...(isCodingPlan ? { fixedModelSelection: true } : {}),
      supportsLiveModelRefresh: false,
      description: toPlainText(readString(provider.description)) || undefined,
      apiKeyUrl: readString(provider.api_key_url).trim() || undefined,
      catalogModels,
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
  const region = instance.region?.trim().replace(/-\d+$/, "") || undefined;
  const source = productConfig.getFilteredModelProviders?.(region, instance.regionId)
    ?? productConfig.modelProviders
    ?? liveProviders
    ?? [];
  return adaptProductModelProviders(source);
}
