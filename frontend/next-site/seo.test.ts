import { afterEach, describe, expect, it, vi } from "vitest";

async function importSeoWithRegion(region: "cn" | "global") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  vi.stubEnv("VITE_REGION", region);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_CN_SITE_URL", "");
  vi.stubEnv("CN_SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_GLOBAL_SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_INTL_SITE_URL", "");
  vi.stubEnv("GLOBAL_SITE_URL", "");
  vi.stubEnv("INTL_SITE_URL", "");

  return import("./seo");
}

describe("next-site SEO origin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults the global build origin to lightvela.ai", async () => {
    const { siteUrl } = await importSeoWithRegion("global");

    expect(siteUrl()).toBe("https://lightvela.ai");
  });

  it("keeps the cn build origin on lightvela.com", async () => {
    const { siteUrl } = await importSeoWithRegion("cn");

    expect(siteUrl()).toBe("https://lightvela.com");
  });
});
