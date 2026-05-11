import { describe, expect, it } from "vitest";

import { assetUrl, cdnBase, isUsingCdn } from "./asset-url";

describe("assetUrl", () => {
  it("keeps frontend-owned assets on the current site", () => {
    expect(assetUrl("/assets/landing/hero/hero-img-1.png")).toBe("/assets/landing/hero/hero-img-1.png");
    expect(assetUrl("login/qq-logo.png")).toBe("/login/qq-logo.png");
  });

  it("passes through external URLs and data URIs", () => {
    expect(assetUrl("https://example.com/logo.png")).toBe("https://example.com/logo.png");
    expect(assetUrl("//example.com/logo.png")).toBe("//example.com/logo.png");
    expect(assetUrl("data:image/png;base64,abcd")).toBe("data:image/png;base64,abcd");
  });

  it("keeps compatibility exports for callers that still import them", () => {
    expect(isUsingCdn).toBe(false);
    expect(cdnBase).toBe("");
  });
});
