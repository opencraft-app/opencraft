import { describe, expect, it } from "vitest";

import { MODEL_PROVIDER_RAINBOW_KEY, parseRainbowModelProviders } from "../model-provider-parser";

const rainbowValue = (value: unknown) => [{
  key: MODEL_PROVIDER_RAINBOW_KEY.zh,
  value: JSON.stringify(value),
}];

describe("parseRainbowModelProviders", () => {
  it("treats a wholly malformed Rainbow provider group as a parse failure", () => {
    expect(parseRainbowModelProviders(rainbowValue([
      { value: "missing-category", models: [] },
      { value: "missing-endpoint", category: "coding_plan", api: "openai-completions", models: [] },
      { value: "missing-api", category: "api", base_url: "https://example.com/v1", models: [] },
    ]), false)).toBeNull();
  });

  it("keeps a structurally valid empty catalog so the Provider can be hidden without restoring it", () => {
    expect(parseRainbowModelProviders(rainbowValue([{
      value: "empty-plan",
      category: "coding_plan",
      provider: "empty-plan",
      provider_name: "Empty Plan",
      description: "",
      api_key_url: "",
      base_url: "https://empty.example.com/v1",
      api: "openai-completions",
      models: [],
    }]), false)).toEqual([
      expect.objectContaining({ value: "empty-plan", models: [] }),
    ]);
  });
});
