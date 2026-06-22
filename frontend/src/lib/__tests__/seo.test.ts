import { describe, expect, it } from "vitest";
import { DEFAULT_SEO_TITLE, SEO_DESCRIPTION, SEO_KEYWORDS, getFullSeoMeta, getSeoMeta } from "@/lib/seo";

describe("seo meta", () => {
  it("keeps the landing page title unchanged", () => {
    const meta = getSeoMeta("/");

    expect(meta.title).toBe(DEFAULT_SEO_TITLE);
    expect(meta.description).toBe(SEO_DESCRIPTION);
    expect(meta.keywords).toBe(SEO_KEYWORDS);
  });

  it("uses a unique page title with the LightVela suffix for regular pages", () => {
    expect(getSeoMeta("/about").title).toBe("关于我们 | LightVela 云端专属个人 Agent");
    expect(getSeoMeta("/changelog").title).toBe("更新日志 | LightVela 云端专属个人 Agent");
  });

  it("uses docs and Agent section names in page titles", () => {
    expect(getSeoMeta("/docs/overview").title).toBe("LightVela 是什么 | LightVela 云端专属个人 Agent");
    expect(getSeoMeta("/agents/memory").title).toBe("记忆管理 | LightVela 云端专属个人 Agent");
  });

  it("uses app route names and falls back for missing pages", () => {
    expect(getSeoMeta("/bots/bot-1/terminal").title).toBe("终端 | LightVela 云端专属个人 Agent");
    expect(getSeoMeta("/missing-page").title).toBe("页面不存在 | LightVela 云端专属个人 Agent");
  });

  it("uses route-specific titles for auth helper pages", () => {
    expect(getSeoMeta("/auth/sign-up-code").title).toBe("输入验证码 | LightVela 云端专属个人 Agent");
    expect(getSeoMeta("/auth/forgot-password").title).toBe("找回密码 | LightVela 云端专属个人 Agent");
    expect(getSeoMeta("/auth/sign-up-code", "global").title).toBe(
      "Verify Code | LightVela · Your Personal Cloud AI Agent",
    );
    expect(getSeoMeta("/auth/forgot-password", "global").title).toBe(
      "Forgot Password | LightVela · Your Personal Cloud AI Agent",
    );
  });

  it("renders English titles and suffix for the global region", () => {
    const globalSuffix = "LightVela · Your Personal Cloud AI Agent";
    expect(getSeoMeta("/", "global").title).toBe("LightVela | Your Personal Cloud AI Agent");
    expect(getSeoMeta("/about", "global").title).toBe(`About LightVela | ${globalSuffix}`);
    expect(getSeoMeta("/docs/overview", "global").title).toBe(`What is LightVela | ${globalSuffix}`);
    expect(getSeoMeta("/agents/memory", "global").title).toBe(`Memory | ${globalSuffix}`);
    expect(getSeoMeta("/bots/bot-1/terminal", "global").title).toBe(`Terminal | ${globalSuffix}`);
    expect(getSeoMeta("/missing-page", "global").title).toBe(`Page Not Found | ${globalSuffix}`);
  });
});

/**
 * 国际站 multi-URL i18n：访问 `/en-us/...` 应返回英文 meta；访问 `/zh-cn/...`
 * 应返回中文 meta（复用 cn 表，避免双源），且 `<html lang>` / `og:locale`
 * 跟随 URL 前缀切换。
 *
 * 这一组断言是 codex CR P0-B 的回归守护：之前 SPA hydration 后
 * `useRouteSeoMeta` 会把 Next 写好的 `<html lang="zh-CN">` 覆盖回 en-US，
 * title 也被覆盖成 "Page Not Found | ..."（裸路径表 miss）。
 */
describe("seo meta — global multi-URL language prefix", () => {
  const cnSuffix = "LightVela 云端专属个人 Agent";
  const globalSuffix = "LightVela · Your Personal Cloud AI Agent";

  it("/en-us/about returns English title (default global) without 'Page Not Found'", () => {
    expect(getSeoMeta("/en-us/about", "global").title).toBe(`About LightVela | ${globalSuffix}`);
    expect(getSeoMeta("/en-us/about", "global").title).not.toContain("Page Not Found");
  });

  it("/zh-cn/about returns Chinese title (reuses cn table)", () => {
    expect(getSeoMeta("/zh-cn/about", "global").title).toBe(`关于我们 | ${cnSuffix}`);
    expect(getSeoMeta("/zh-cn/about", "global").title).not.toContain("Page Not Found");
  });

  it("/en-us/docs/overview returns English doc title", () => {
    expect(getSeoMeta("/en-us/docs/overview", "global").title).toBe(`What is LightVela | ${globalSuffix}`);
  });

  it("/zh-cn/docs/overview returns Chinese doc title", () => {
    expect(getSeoMeta("/zh-cn/docs/overview", "global").title).toBe(`LightVela 是什么 | ${cnSuffix}`);
  });

  it("/zh-sg/docs/overview returns Chinese doc title with zh-SG locale", () => {
    expect(getSeoMeta("/zh-sg/docs/overview", "global").title).toBe(`LightVela 是什么 | ${cnSuffix}`);
    expect(getFullSeoMeta("/zh-sg/docs/overview", "global").htmlLang).toBe("zh-SG");
    expect(getFullSeoMeta("/zh-sg/docs/overview", "global").ogLocale).toBe("zh_SG");
  });

  it("getFullSeoMeta htmlLang follows URL prefix", () => {
    expect(getFullSeoMeta("/en-us/about", "global").htmlLang).toBe("en-US");
    expect(getFullSeoMeta("/zh-cn/about", "global").htmlLang).toBe("zh-CN");
    expect(getFullSeoMeta("/about", "global").htmlLang).toBe("en-US"); // 裸路径走 site 默认
  });

  it("getFullSeoMeta ogLocale follows URL prefix", () => {
    expect(getFullSeoMeta("/en-us/docs/overview", "global").ogLocale).toBe("en_US");
    expect(getFullSeoMeta("/zh-cn/docs/overview", "global").ogLocale).toBe("zh_CN");
  });

  it("getFullSeoMeta canonical preserves the language prefix", () => {
    /* canonical 必须保留 locale 前缀，与 Next hreflang 集群对齐
       （每个 URL 的 canonical 指向自己，而不是裸路径） */
    const meta = getFullSeoMeta("/zh-sg/docs/overview", "global", { siteUrl: "https://lightvela.ai" });
    expect(meta.canonical).toBe("https://lightvela.ai/zh-sg/docs/overview");
  });

  it("cn region is unaffected (no /en /zh prefix concept)", () => {
    /* 国内站 stripUrlLangPrefix 不应影响行为 —— /en/foo 在 cn 站算未知路径，
       走 fallback。这里只断言不破坏现有 cn 测试。 */
    expect(getFullSeoMeta("/about", "cn").htmlLang).toBe("zh-CN");
    expect(getFullSeoMeta("/about", "cn").ogLocale).toBe("zh_CN");
  });
});
