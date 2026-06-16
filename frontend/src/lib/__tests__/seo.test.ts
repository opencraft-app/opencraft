import { describe, expect, it } from "vitest";
import { DEFAULT_SEO_TITLE, SEO_DESCRIPTION, SEO_KEYWORDS, getSeoMeta } from "@/lib/seo";

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
