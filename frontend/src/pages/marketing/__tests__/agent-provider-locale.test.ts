import { describe, expect, it } from "vitest";
import { shouldUseEnglishProviderData } from "@/pages/marketing/agent-provider-locale";

describe("shouldUseEnglishProviderData", () => {
  it.each([
    ["en", true],
    ["en-US", true],
    ["es", true],
    ["es-MX", true],
    ["zh-CN", false],
    ["zh-Hant", false],
    ["id-ID", false],
    [undefined, false],
  ])("returns %s for locale %s", (locale, expected) => {
    expect(shouldUseEnglishProviderData(locale)).toBe(expected);
  });
});
