import { afterEach, describe, expect, it, vi } from "vitest";

const initI18nSpy = vi.hoisted(() => vi.fn());
const enTranslation = vi.hoisted(() => ({ hello: "Hello" }));

vi.mock("@tencent/tea-sdk-lightclaw", () => ({
  initI18n: initI18nSpy,
}));

vi.mock("@tencent/tea-sdk-lightclaw/i18n/translation/en", () => ({
  translation: enTranslation,
}));

async function loadI18nEnv(region: "cn" | "global", storedLocale?: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  window.localStorage.clear();
  if (storedLocale) {
    window.localStorage.setItem("lw-locale", storedLocale);
  }
  delete (window as Window & { VERSION?: string }).VERSION;
  initI18nSpy.mockClear();

  await import("@/lib/i18n-env");
}

afterEach(() => {
  window.localStorage.clear();
  delete (window as Window & { VERSION?: string }).VERSION;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("i18n-env", () => {
  it("keeps the domestic SDK environment Chinese when localStorage has stale English", async () => {
    await loadI18nEnv("cn", "en-US");

    expect((window as Window & { VERSION?: string }).VERSION).toBeUndefined();
    expect(initI18nSpy).toHaveBeenCalledWith();
  });

  it("keeps the global SDK environment English by default", async () => {
    await loadI18nEnv("global");

    expect((window as Window & { VERSION?: string }).VERSION).toBe("en");
    expect(initI18nSpy).toHaveBeenCalledWith({ translation: enTranslation });
  });
});
