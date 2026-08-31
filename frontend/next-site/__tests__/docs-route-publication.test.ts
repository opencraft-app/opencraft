import { describe, expect, it } from "vitest";

import { LOCALE_DEFINITIONS } from "@/i18n/locales.config";
import {
  docsI18nLanguagesForRuntime,
  docsRouteLocalesForRegion,
} from "@next-site/docs-route-publication";

describe("docs route publication", () => {
  it("keeps hidden Japanese docs out of the current global and domestic builds", () => {
    expect(docsRouteLocalesForRegion("global")).not.toContain("ja-jp");
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

  it("includes Japanese docs only for an explicit non-production global preview", () => {
    expect(docsRouteLocalesForRegion("global", LOCALE_DEFINITIONS, {
      isProduction: false,
      previewLocales: "ja-JP",
    })).toContain("ja-jp");
    expect(docsRouteLocalesForRegion("global", LOCALE_DEFINITIONS, {
      isProduction: true,
      previewLocales: "ja-JP",
    })).not.toContain("ja-jp");
    expect(docsRouteLocalesForRegion("cn", LOCALE_DEFINITIONS, {
      isProduction: false,
      previewLocales: "ja-JP",
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
    ]);
  });
});
