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

  it("/en/changelog and /zh/changelog return localized changelog titles", () => {
    expect(getSeoMeta("/en/changelog", "global").title).toBe(`Changelog | ${globalSuffix}`);
    expect(getSeoMeta("/zh/changelog", "global").title).toBe(`更新日志 | ${cnSuffix}`);
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

  it("returns Spanish metadata and locale fields for /es public and docs routes", () => {
    const home = getFullSeoMeta("/es", "global");
    const about = getFullSeoMeta("/es/about", "global");
    const docs = getFullSeoMeta("/es/docs/overview", "global");

    expect(home.title).toBe("LightVela | Tu agente personal de IA en la nube");
    expect(about.title).toContain("Acerca de LightVela");
    expect(docs.title).toContain("Qué es LightVela");
    expect(docs.title).not.toContain("¿");
    for (const meta of [home, about, docs]) {
      expect(meta.title).not.toContain("Page Not Found");
      expect(meta.description).not.toContain("LightVela is a cloud Agent hosting product");
      expect(meta.htmlLang).toBe("es");
      expect(meta.ogLocale).toBe("es_ES");
      expect(meta.ogUrl).toBe(meta.canonical);
      expect(meta.canonical).toContain("https://lightvela.ai/es");
    }
  });

  it("returns Spanish titles for locale-projected private product routes", () => {
    const suffix = "LightVela · Tu agente personal de IA en la nube";

    expect(getSeoMeta("/es/agents", "global").title).toBe(`Mis agentes | ${suffix}`);
    expect(getSeoMeta("/es/agents/skills", "global").title).toBe(`Habilidades | ${suffix}`);
    expect(getSeoMeta("/es/account", "global").title).toBe(`Cuenta | ${suffix}`);
    expect(getSeoMeta("/es/account/orders", "global").title).toBe(`Pedidos | ${suffix}`);
    expect(getSeoMeta("/es/plans/select", "global").title).toBe(`Elige un plan | ${suffix}`);
  });

  it("returns Japanese metadata and locale fields for prepared /ja-jp routes", () => {
    const home = getFullSeoMeta("/ja-jp", "global");
    const about = getFullSeoMeta("/ja-jp/about", "global");
    const docs = getFullSeoMeta("/ja-jp/docs/overview", "global");

    expect(home.title).toBe("LightVela | あなた専用のクラウドAIエージェント");
    expect(about.title).toContain("LightVelaについて");
    expect(docs.title).toContain("LightVelaとは");
    for (const meta of [home, about, docs]) {
      expect(meta.description).toMatch(/[\u3040-\u30ff]/);
      expect(meta.htmlLang).toBe("ja-JP");
      expect(meta.ogLocale).toBe("ja_JP");
      expect(meta.ogUrl).toBe(meta.canonical);
      expect(meta.canonical).toContain("https://lightvela.ai/ja-jp");
    }
  });

  it("returns Japanese titles for locale-projected private product routes", () => {
    const suffix = "LightVela · あなた専用のクラウドAIエージェント";

    expect(getSeoMeta("/ja-jp/agents", "global").title).toBe(`マイエージェント | ${suffix}`);
    expect(getSeoMeta("/ja-jp/agents/skills", "global").title).toBe(`スキル | ${suffix}`);
    expect(getSeoMeta("/ja-jp/account", "global").title).toBe(`アカウント | ${suffix}`);
    expect(getSeoMeta("/ja-jp/plans/select", "global").title).toBe(`プランを選択 | ${suffix}`);
  });

  it("returns Korean metadata and locale fields for prepared /ko-kr routes", () => {
    const home = getFullSeoMeta("/ko-kr", "global");
    const about = getFullSeoMeta("/ko-kr/about", "global");
    const docs = getFullSeoMeta("/ko-kr/docs/overview", "global");

    expect(home.title).toBe("LightVela | 나만의 클라우드 AI 에이전트");
    expect(about.title).toContain("LightVela 소개");
    expect(docs.title).toContain("LightVela란 무엇인가요");
    for (const meta of [home, about, docs]) {
      expect(meta.description).toMatch(/[가-힣]/);
      expect(meta.htmlLang).toBe("ko-KR");
      expect(meta.ogLocale).toBe("ko_KR");
      expect(meta.ogUrl).toBe(meta.canonical);
      expect(meta.canonical).toContain("https://lightvela.ai/ko-kr");
    }
  });

  it("returns Korean titles for locale-projected private product routes", () => {
    const suffix = "LightVela · 나만의 클라우드 AI 에이전트";

    expect(getSeoMeta("/ko-kr/agents", "global").title).toBe(`내 에이전트 | ${suffix}`);
    expect(getSeoMeta("/ko-kr/agents/skills", "global").title).toBe(`스킬 | ${suffix}`);
    expect(getSeoMeta("/ko-kr/account", "global").title).toBe(`계정 | ${suffix}`);
    expect(getSeoMeta("/ko-kr/plans/select", "global").title).toBe(`플랜 선택 | ${suffix}`);
  });
});
