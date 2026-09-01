import { describe, expect, it } from "vitest";

import { LOCALE_DEFINITIONS } from "@/i18n/locales.config";
import {
  docsI18nLanguagesForRuntime,
  docsRouteLocalesForRegion,
} from "@next-site/docs-route-publication";

describe("docs route publication", () => {
  it("publishes Japanese and Korean docs globally while keeping domestic builds empty", () => {
    expect(docsRouteLocalesForRegion("global")).toEqual(expect.arrayContaining(["ja-jp", "ko-kr"]));
    expect(docsRouteLocalesForRegion("cn")).toEqual([]);
  });

  it("automatically includes Japanese docs after both registry gates open", () => {
    const japaneseReadyDefinitions = LOCALE_DEFINITIONS.map((definition) =>
      definition.code === "ja-JP"
        ? { ...definition, switcherVisible: true, translationRequired: true }
        : definition,
    );

    expect(docsRouteLocalesForRegion("global", japaneseReadyDefinitions)).toContain("ja-jp");
  });

  it("keeps published Japanese docs in production and out of domestic preview", () => {
    expect(docsRouteLocalesForRegion("global", LOCALE_DEFINITIONS, {
      isProduction: false,
      previewLocales: "ja-JP",
    })).toContain("ja-jp");
    expect(docsRouteLocalesForRegion("global", LOCALE_DEFINITIONS, {
      isProduction: true,
      previewLocales: "ja-JP",
    })).toContain("ja-jp");
    expect(docsRouteLocalesForRegion("cn", LOCALE_DEFINITIONS, {
      isProduction: false,
      previewLocales: "ja-JP",
    })).toEqual([]);
  });

  it("keeps published Korean docs in production and out of domestic preview", () => {
    expect(docsRouteLocalesForRegion("global", LOCALE_DEFINITIONS, {
      isProduction: false,
      previewLocales: "ja-JP,ko-KR",
    })).toContain("ko-kr");
    expect(docsRouteLocalesForRegion("global", LOCALE_DEFINITIONS, {
      isProduction: true,
      previewLocales: "ja-JP,ko-KR",
    })).toContain("ko-kr");
    expect(docsRouteLocalesForRegion("cn", LOCALE_DEFINITIONS, {
      isProduction: false,
      previewLocales: "ja-JP,ko-KR",
    })).toEqual([]);
  });

  it("passes previewed Japanese through to the Fumadocs locale loader", () => {
    expect(docsI18nLanguagesForRuntime([
      "en-us",
      "zh-cn",
      "zh-sg",
      "zh-hant",
      "id-id",
      "es",
      "ja-jp",
      "ko-kr",
    ])).toEqual([
      "en-us",
      "zh-cn",
      "zh-sg",
      "zh-hant",
      "id-id",
      "es",
      "ja-jp",
      "ko-kr",
    ]);
  });
});
