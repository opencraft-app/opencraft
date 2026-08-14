import { afterEach, describe, expect, it, vi } from "vitest";

async function loadI18n(region: "cn" | "global", pathname: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  window.history.replaceState(null, "", pathname);
  return import("@/i18n");
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("i18n initial locale", () => {
  it("keeps the global bare root in English when localStorage has stale Chinese", async () => {
    window.localStorage.setItem("lw-locale", "zh-CN");

    const { default: i18n } = await loadI18n("global", "/");

    expect(i18n.language).toBe("en-US");
  });

  it("keeps explicit global Chinese routes in Chinese", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("global", "/zh-sg/");

    expect(i18n.language).toBe("zh-CN");
  });

  it("keeps the previous override behavior outside the global bare root", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("cn", "/");

    expect(i18n.language).toBe("en-US");
  });
});
