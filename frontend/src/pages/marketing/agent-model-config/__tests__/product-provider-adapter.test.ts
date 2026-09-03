import type { IModelProvider } from "@tencent/tea-sdk-lightclaw";
import { describe, expect, it } from "vitest";

import { adaptProductModelProviders, resolveProductModelProviderOptions } from "../product-provider-adapter";

const provider = (value: string): IModelProvider => ({
  value,
  category: "api",
  provider: value,
  provider_name: value,
  description: "",
  api_key_url: "",
  base_url: `https://${value}.example.com/v1`,
  api: "openai-completions",
  models: [],
});

describe("adaptProductModelProviders", () => {
  it("preserves the product catalog shape and maps SDK protocols to Hermes modes", () => {
    const providers = adaptProductModelProviders([
      {
        value: "alpha-plan",
        category: "coding_plan",
        provider: "alpha",
        provider_name: "Alpha <strong>Plan</strong>",
        description: "<p>Fast coding plan</p>",
        api_key_url: "https://alpha.example.com/keys",
        base_url: "https://alpha.example.com/v1",
        api: "openai-completions",
        models: [{ id: "alpha-code", name: "Alpha Code" }],
      },
      {
        value: "claude-api",
        category: "api",
        provider: "anthropic",
        provider_name: "Claude API",
        description: "Native messages API",
        api_key_url: "https://console.anthropic.com/settings/keys",
        base_url: "https://api.anthropic.com/v1",
        api: "anthropic-messages",
        models: [{ id: "claude-sonnet", name: "Claude Sonnet" }],
      },
    ]);

    expect(providers).toEqual([
      {
        providerKey: "alpha-plan",
        providerName: "Alpha Plan",
        category: "coding_plan",
        description: "Fast coding plan",
        apiKeyUrl: "https://alpha.example.com/keys",
        baseUrl: "https://alpha.example.com/v1",
        apiMode: "chat_completions",
        discoveryStrategy: "live",
        catalogModels: [{ id: "alpha-code", name: "Alpha Code" }],
      },
      expect.objectContaining({
        providerKey: "claude-api",
        category: "api",
        apiMode: "anthropic_messages",
      }),
    ]);
  });

  it("uses the static product catalog for MiniMax providers", () => {
    const [adaptedProvider] = adaptProductModelProviders([{
      value: "minimax_coding",
      category: "coding_plan",
      provider: "minimax",
      provider_name: "MiniMax Token Plan",
      description: "",
      api_key_url: "https://platform.minimaxi.com/keys",
      base_url: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      models: [{ id: "MiniMax-M2.7", name: "MiniMax-M2.7" }],
    }]);

    expect(adaptedProvider).toEqual(expect.objectContaining({
      providerKey: "minimax_coding",
      discoveryStrategy: "catalog",
    }));
  });

  it("uses the Rainbow Hy Token Plan catalog while keeping fixed selection", () => {
    const [adaptedProvider] = adaptProductModelProviders([{
      value: "tencent_hy_token_plan",
      category: "coding_plan",
      provider: "tencenthytokenplan",
      provider_name: "腾讯云 Hy Token Plan（个人版）",
      description: "七彩石最新模型说明",
      api_key_url: "https://console.cloud.tencent.com/tokenhub/tokenplan/hy",
      base_url: "https://api.lkeap.cloud.tencent.com/plan/v3",
      api: "openai-completions",
      models: [
        { id: "hy4-preview", name: "Hy4 Preview", isDefault: true },
        { id: "hy-next", name: "Hy Next" },
      ],
    }]);

    expect(adaptedProvider).toEqual(expect.objectContaining({
      providerKey: "tencent_hy_token_plan",
      discoveryStrategy: "catalog",
      fixedModelSelection: true,
      validateBeforeAdd: true,
      description: "七彩石最新模型说明",
      catalogModels: [
        { id: "hy4-preview", name: "Hy4 Preview" },
        { id: "hy-next", name: "Hy Next" },
      ],
    }));
  });

  it("hides the Rainbow Hy Token Plan provider when it has no valid models", () => {
    expect(adaptProductModelProviders([{
      value: "tencent_hy_token_plan",
      category: "coding_plan",
      provider: "tencenthytokenplan",
      provider_name: "腾讯云 Hy Token Plan（个人版）",
      description: "暂无模型",
      api_key_url: "",
      base_url: "https://api.lkeap.cloud.tencent.com/plan/v3",
      api: "openai-completions",
      models: [{ id: "  ", name: "无效模型" }],
    }])).toEqual([]);
  });

  it("does not inject the Hy Token Plan provider when Rainbow omits it", () => {
    expect(adaptProductModelProviders([])).toEqual([]);
  });

  it("extracts untrusted provider HTML without writing through element innerHTML", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (!descriptor?.configurable) throw new Error("innerHTML descriptor must be configurable in this test environment");
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      get: descriptor.get,
      set() {
        throw new Error("innerHTML sink should not be used");
      },
    });
    try {
      const [adaptedProvider] = adaptProductModelProviders([{
        value: "unsafe",
        category: "api",
        provider: "unsafe",
        provider_name: "Unsafe <strong>Provider</strong><img src=x onerror=alert(1)>",
        description: "<p>Fast &amp; safe</p><script>alert(1)</script>",
        api_key_url: "",
        base_url: "https://unsafe.example.com/v1",
        api: "openai-completions",
        models: [],
      }]);

      if (!adaptedProvider) throw new Error("Expected the Provider to be adapted");
      expect(adaptedProvider.providerName).toBe("Unsafe Provider");
      expect(adaptedProvider.description).toBe("Fast & safe");
    } finally {
      Object.defineProperty(Element.prototype, "innerHTML", descriptor);
    }
  });

  it("filters OAuth-only and non-probeable entries without changing source order", () => {
    const providers = adaptProductModelProviders([
      {
        value: "oauth-only",
        category: "api",
        provider: "codex",
        provider_name: "OAuth only",
        description: "",
        api_key_url: "",
        base_url: "https://oauth.example.com/v1",
        api: "openai-responses",
        models: [],
        oauth: { provider: "codex", openclawProvider: "openai-codex", exclusive: true },
      },
      {
        value: "missing-endpoint",
        category: "api",
        provider: "missing",
        provider_name: "Missing endpoint",
        description: "",
        api_key_url: "",
        base_url: "",
        api: "openai-completions",
        models: [],
      },
      {
        value: "first",
        category: "api",
        provider: "first",
        provider_name: "First",
        description: "",
        api_key_url: "",
        base_url: "https://first.example.com/v1",
        api: "openai-codex-responses",
        models: [],
      },
      {
        value: "second",
        category: "api",
        provider: "second",
        provider_name: "Second",
        description: "",
        api_key_url: "",
        base_url: "https://second.example.com/v1",
        api: "unknown-mode",
        models: [],
      },
    ]);

    expect(providers.map((provider) => provider.providerKey)).toEqual(["first"]);
    expect(providers.map((provider) => provider.apiMode)).toEqual(["codex_responses"]);
  });

  it("honors the product filter before config and live-catalog fallbacks", () => {
    const live = [provider("live")];
    const configured = [provider("configured")];
    const filtered = [provider("filtered")];

    let filterArgs: [string | undefined, number | undefined] | null = null;
    expect(resolveProductModelProviderOptions({
      modelProviders: configured,
      getFilteredModelProviders: (region, regionId) => {
        filterArgs = [region, regionId];
        return filtered;
      },
    }, live, { region: "ap-hongkong-3", regionId: 5 }).map((item) => item.providerKey)).toEqual(["filtered"]);
    expect(filterArgs).toEqual(["ap-hongkong", 5]);
    expect(resolveProductModelProviderOptions({ modelProviders: configured }, live)
      .map((item) => item.providerKey)).toEqual(["configured"]);
    expect(resolveProductModelProviderOptions({}, live)
      .map((item) => item.providerKey)).toEqual(["live"]);
  });

  it("does not infer an instance region from a numeric region ID", () => {
    let filterArgs: [string | undefined, number | undefined] | null = null;

    resolveProductModelProviderOptions({
      getFilteredModelProviders: (region, regionId) => {
        filterArgs = [region, regionId];
        return [];
      },
    }, undefined, { regionId: 5 });

    expect(filterArgs).toEqual([undefined, 5]);
  });
});
