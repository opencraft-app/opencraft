import { afterEach, describe, expect, it, vi } from "vitest";

async function loadRegion(region: "cn" | "global") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  return import("@/lib/region");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("switchLocaleInPath", () => {
  it("keeps public paths unchanged for cn builds", async () => {
    const { switchLocaleInPath } = await loadRegion("cn");

    expect(switchLocaleInPath("/docs/overview", "en-US")).toBe("/docs/overview");
    expect(switchLocaleInPath("/docs/overview", "zh-SG")).toBe("/docs/overview");
  });

  it("uses zh-sg as the global Chinese public-docs locale", async () => {
    const { switchLocaleInPath } = await loadRegion("global");

    expect(switchLocaleInPath("/docs/overview", "zh-CN")).toBe("/zh-sg/docs/overview");
    expect(switchLocaleInPath("/docs/overview", "zh-SG")).toBe("/zh-sg/docs/overview");
    expect(switchLocaleInPath("/en-us/docs/overview", "zh-SG")).toBe("/zh-sg/docs/overview");
    expect(switchLocaleInPath("/zh-cn/docs/overview", "en-US")).toBe("/docs/overview");
  });
});
