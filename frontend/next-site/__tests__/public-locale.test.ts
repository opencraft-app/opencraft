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

  it("publishes the existing runtime routes plus Spanish, Japanese and Korean", () => {
    expect(
      (publicLocaleModule as Partial<{ PUBLIC_RUNTIME_URL_LANGS: readonly string[] }>)
        .PUBLIC_RUNTIME_URL_LANGS,
    ).toEqual(["en-us", "zh-cn", "zh-sg", "zh-hant", "id-id", "es", "ja-jp", "ko-kr"]);
    expect(publicRouteLocaleFromLang("ja-jp")).toEqual({ locale: "ja-JP", localized: true });
    expect(publicRouteLocaleFromLang("ko-kr")).toEqual({ locale: "ko-KR", localized: true });
  });

  it("keeps published Japanese and Korean routes available during global development", async () => {
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
    expect(previewModule.publicRouteLocaleFromLang("ko-kr")).toEqual({
      locale: "ko-KR",
      localized: true,
    });
  });

  it("opens Japanese and Korean routes together for the explicit global development preview", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_LOCALES", "ja-JP,ko-KR");
    vi.resetModules();

    const previewModule = await import("@next-site/public-locale");

    expect(previewModule.PUBLIC_RUNTIME_URL_LANGS).toContain("ja-jp");
    expect(previewModule.PUBLIC_RUNTIME_URL_LANGS).toContain("ko-kr");
    expect(previewModule.publicRouteLocaleFromLang("ko-kr")).toEqual({
      locale: "ko-KR",
      localized: true,
    });
  });
});
