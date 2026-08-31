import { afterEach, describe, expect, it, vi } from "vitest";

import * as publicLocaleModule from "@next-site/public-locale";

const { publicRouteLocaleFromLang } = publicLocaleModule;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("publicRouteLocaleFromLang", () => {
  it("parses the Spanish public route locale", () => {
    expect(publicRouteLocaleFromLang("es")).toEqual({ locale: "es", localized: true });
  });

  it("rejects an unregistered route locale", () => {
    expect(publicRouteLocaleFromLang("unknown")).toBeNull();
  });

  it("publishes only the existing runtime routes plus Spanish", () => {
    expect(
      (publicLocaleModule as Partial<{ PUBLIC_RUNTIME_URL_LANGS: readonly string[] }>)
        .PUBLIC_RUNTIME_URL_LANGS,
    ).toEqual(["en-us", "zh-cn", "zh-sg", "zh-hant", "id-id", "es"]);
    expect(publicRouteLocaleFromLang("ja-jp")).toBeNull();
    expect(publicRouteLocaleFromLang("ko-kr")).toBeNull();
  });

  it("opens the Japanese route only for an explicit global development preview", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_LOCALES", "ja-JP");
    vi.resetModules();

    const previewModule = await import("@next-site/public-locale");

    expect(previewModule.PUBLIC_RUNTIME_URL_LANGS).toContain("ja-jp");
    expect(previewModule.publicRouteLocaleFromLang("ja-jp")).toEqual({
      locale: "ja-JP",
      localized: true,
    });
    expect(previewModule.publicRouteLocaleFromLang("ko-kr")).toBeNull();
  });
});
