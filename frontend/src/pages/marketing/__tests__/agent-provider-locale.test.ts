import { describe, expect, it } from "vitest";
import {
  resolveAgentConsoleCollectionLabel,
  resolveAgentDisplayName,
  resolveAgentSessionTitle,
  shouldUseEnglishProviderData,
} from "@/pages/marketing/agent-provider-locale";

describe("shouldUseEnglishProviderData", () => {
  it.each([
    ["channel", "en-US", "Channels"],
    ["model", "en", "Models"],
    ["channel", "zh-CN", "translated:通道"],
    ["model", "es", "translated:模型"],
  ] as const)("resolves the %s collection label for %s", (section, locale, expected) => {
    expect(resolveAgentConsoleCollectionLabel(section, locale, (copy) => `translated:${copy}`)).toBe(expected);
  });

  it.each([
    ["en", true],
    ["en-US", true],
    ["es", true],
    ["es-MX", true],
    ["ja-JP", true],
    ["ko-KR", true],
    ["id-ID", true],
    ["zh-CN", false],
    ["zh-Hant", false],
    [undefined, false],
  ])("returns %s for locale %s", (locale, expected) => {
    expect(shouldUseEnglishProviderData(locale)).toBe(expected);
  });

  it("localizes the backend default Hermes name without touching custom names", () => {
    const translate = (copy: string) => copy === "我的Hermes" ? "私のHermes" : copy;

    expect(resolveAgentDisplayName("我的Hermes", translate)).toBe("私のHermes");
    expect(resolveAgentDisplayName("Jasmin Agent", translate)).toBe("Jasmin Agent");
  });

  it("shows the legacy SDK default session title in English for non-Chinese locales", () => {
    expect(resolveAgentSessionTitle("新会话", "ko-KR", "기본 세션")).toBe("New chat");
    expect(resolveAgentSessionTitle("新会话", "ja-JP", "デフォルトセッション")).toBe("New chat");
    expect(resolveAgentSessionTitle("新会话", "zh-CN", "默认会话")).toBe("新会话");
    expect(resolveAgentSessionTitle("历史会话", "ko-KR", "기본 세션")).toBe("历史会话");
    expect(resolveAgentSessionTitle("", "ko-KR", "기본 세션")).toBe("기본 세션");
  });
});
