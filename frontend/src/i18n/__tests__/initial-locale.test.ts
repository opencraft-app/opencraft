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

  it("keeps explicit global Indonesian routes in Indonesian", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("global", "/id-id/");

    expect(i18n.language).toBe("id-ID");
  });

  it("keeps the domestic site in Chinese when localStorage has stale English", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("cn", "/");

    expect(i18n.language).toBe("zh-CN");
  });

  /**
   * 控制台等路径（/agents、/auth）刻意不做 URL 本地化，只能依赖 localStorage
   * 延续语言。因此从带语言前缀的公开页进入时，必须把该语言持久化下来，
   * 否则「从 /id-id/ 跳到 /agents」会回退成英文。
   */
  it("persists the locale resolved from an explicit URL prefix", async () => {
    window.localStorage.clear();

    const { default: i18n } = await loadI18n("global", "/id-id/subscribe");

    expect(i18n.language).toBe("id-ID");
    expect(window.localStorage.getItem("lw-locale")).toBe("id-ID");
  });

  it("keeps non-localized console routes in the persisted locale", async () => {
    window.localStorage.setItem("lw-locale", "id-ID");

    const { default: i18n } = await loadI18n("global", "/agents");

    expect(i18n.language).toBe("id-ID");
  });
});
