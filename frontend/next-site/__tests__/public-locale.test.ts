import { describe, expect, it } from "vitest";

import * as publicLocaleModule from "@next-site/public-locale";

const { publicRouteLocaleFromLang } = publicLocaleModule;

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
});
