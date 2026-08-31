import { afterEach, describe, expect, it, vi } from "vitest";

async function loadI18n(
  region: "cn" | "global",
  pathname: string,
  previewLocales?: string,
) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  if (previewLocales) {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_LOCALES", previewLocales);
  }
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

  it("keeps explicit global Spanish routes in Spanish and persists the locale", async () => {
    window.localStorage.setItem("lw-locale", "en-US");

    const { default: i18n } = await loadI18n("global", "/es/subscribe");

    expect(i18n.language).toBe("es");
    expect(window.localStorage.getItem("lw-locale")).toBe("es");
  });

  it("keeps the hidden Japanese dictionary out of the bare-root bundle and loads it on demand", async () => {
    const { default: i18n, ensureLocaleDictionary } = await loadI18n("global", "/");

    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(false);
    await ensureLocaleDictionary("ja-JP");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(true);
    expect(Object.values(i18n.getResourceBundle("ja-JP", "translation") as Record<string, string>).join(""))
      .toMatch(/[ぁ-んァ-ヶ]/);
  });

  it("does not let an unreleased Japanese URL bypass the publication gate", async () => {
    const { default: i18n } = await loadI18n("global", "/ja-jp/");

    expect(i18n.language).toBe("en-US");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(false);
    expect(window.localStorage.getItem("lw-locale")).toBeNull();
  });

  it("loads and persists Japanese from an explicit local preview URL", async () => {
    const { default: i18n } = await loadI18n("global", "/ja-jp/", "ja-JP");

    expect(i18n.language).toBe("ja-JP");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(true);
    expect(window.localStorage.getItem("lw-locale")).toBe("ja-JP");
  });

  it("ignores an unreleased Japanese localStorage override", async () => {
    window.localStorage.setItem("lw-locale", "ja-JP");

    const { default: i18n } = await loadI18n("global", "/agents");

    expect(i18n.language).toBe("en-US");
    expect(i18n.hasResourceBundle("ja-JP", "translation")).toBe(false);
  });

  it("refuses to switch to an unreleased locale through the public setter", async () => {
    const { default: i18n, setLocale } = await loadI18n("global", "/agents");

    setLocale("ja-JP");
    await Promise.resolve();

    expect(i18n.language).toBe("en-US");
    expect(window.localStorage.getItem("lw-locale")).toBeNull();
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
