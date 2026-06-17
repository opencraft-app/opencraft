/**
 * 守护测试：getSeoMeta 的"页面级 description 覆盖"行为。
 *
 * 背景：原始实现 description 全站统一一份（SEO_DESCRIPTION_BY_REGION），
 * 现在 /about 与所有 docs 页面都改为单独定制 description，以便搜索引擎和
 * 社交分享卡的摘要更贴合页面主题。其他页面（changelog / privacy 等）仍
 * 沿用全站默认 description。keywords 不分页面，全站统一。
 *
 * 该文件锁定四件事：
 *   1. /about 在 cn / global 都使用了页面级 description（不等于全站默认）
 *   2. 关键 docs 页（/docs/overview, /docs/quickstart 等）有页面级 description
 *   3. 不在覆盖表中的页面（/changelog, /privacy-policy）回退到全站默认
 *   4. keywords 始终全站统一（/about、/docs/overview 与 / 完全相同）
 */
import { describe, expect, it } from "vitest";

import {
  getSeoMeta,
  SEO_DESCRIPTION,
  SEO_KEYWORDS,
  type SeoRegion,
} from "@/lib/seo-data";

const REGIONS: SeoRegion[] = ["cn", "global"];

describe("getSeoMeta — page-level description override", () => {
  describe("/about has its own description in both regions", () => {
    for (const region of REGIONS) {
      it(`${region}: /about description differs from site default`, () => {
        const aboutMeta = getSeoMeta("/about", region);
        const homeMeta = getSeoMeta("/", region);
        expect(aboutMeta.description).not.toBe(homeMeta.description);
        expect(aboutMeta.description.length).toBeGreaterThan(40);
      });
    }
  });

  describe("docs pages have their own descriptions", () => {
    const cnDocPaths = [
      "/docs",
      "/docs/overview",
      "/docs/quickstart",
      "/docs/account",
      "/docs/core-concepts",
      "/docs/configuration",
      "/docs/configuration/model",
      "/docs/configuration/skill",
      "/docs/configuration/channel-wechat",
      "/docs/configuration/channel-feishu",
      "/docs/configuration/channel-qq",
      "/docs/faq",
    ];

    const globalDocPaths = [
      "/docs",
      "/docs/overview",
      "/docs/quickstart",
      "/docs/core-concepts",
      "/docs/configuration",
      "/docs/configuration/model",
      "/docs/configuration/skill",
      "/docs/configuration/channel-wechat",
      "/docs/configuration/channel-telegram",
      "/docs/configuration/channel-whatsapp",
      "/docs/configuration/channel-discord",
      "/docs/configuration/channel-qq",
      "/docs/configuration/channel-wecom",
      "/docs/configuration/channel-feishu",
      "/docs/configuration/automation",
      "/docs/configuration/agent-chat",
      "/docs/faq",
      "/docs/faq/using-lightvela-safely",
    ];

    for (const path of cnDocPaths) {
      it(`cn: ${path} has page-level description`, () => {
        const meta = getSeoMeta(path, "cn");
        expect(meta.description).not.toBe(getSeoMeta("/", "cn").description);
        expect(meta.description.length).toBeGreaterThan(20);
      });
    }

    for (const path of globalDocPaths) {
      it(`global: ${path} has page-level description`, () => {
        const meta = getSeoMeta(path, "global");
        expect(meta.description).not.toBe(getSeoMeta("/", "global").description);
        expect(meta.description.length).toBeGreaterThan(20);
      });
    }
  });

  describe("non-listed pages fall back to site default description", () => {
    const fallbackPaths = [
      "/changelog",
      "/privacy-policy",
      "/cookie-policy",
      "/open-source-licenses",
    ];

    for (const region of REGIONS) {
      for (const path of fallbackPaths) {
        it(`${region}: ${path} uses site default description`, () => {
          const meta = getSeoMeta(path, region);
          const home = getSeoMeta("/", region);
          // 站点默认 description = 首页 description
          expect(meta.description).toBe(home.description);
        });
      }
    }
  });

  describe("home page description matches site default", () => {
    for (const region of REGIONS) {
      it(`${region}: home description matches SITE description`, () => {
        const home = getSeoMeta("/", region);
        // /  路径不应被加进 PAGE_DESCRIPTIONS_BY_REGION，永远走默认。
        // 站点默认 description 即 SEO_DESCRIPTION_BY_REGION（cn 也直接由 SEO_DESCRIPTION 暴露）。
        if (region === "cn") {
          expect(home.description).toBe(SEO_DESCRIPTION);
        }
        expect(home.description.length).toBeGreaterThan(40);
      });
    }
  });

  describe("keywords are uniform across pages (not per-page)", () => {
    const samplePaths = [
      "/",
      "/about",
      "/docs",
      "/docs/overview",
      "/docs/configuration/model",
      "/changelog",
      "/privacy-policy",
    ];

    for (const region of REGIONS) {
      for (const path of samplePaths) {
        it(`${region}: ${path} keywords equal home keywords`, () => {
          const meta = getSeoMeta(path, region);
          const home = getSeoMeta("/", region);
          expect(meta.keywords).toBe(home.keywords);
        });
      }
    }

    it("cn home keywords match exported SEO_KEYWORDS", () => {
      // 兼容旧导出（默认导出基于 cn）
      expect(getSeoMeta("/", "cn").keywords).toBe(SEO_KEYWORDS);
    });
  });

  describe("normalized pathname (trailing slash) hits the override", () => {
    it("cn: /about/ should still resolve to /about description", () => {
      const a = getSeoMeta("/about", "cn");
      const b = getSeoMeta("/about/", "cn");
      expect(b.description).toBe(a.description);
    });

    it("global: /docs/overview/ resolves like /docs/overview", () => {
      const a = getSeoMeta("/docs/overview", "global");
      const b = getSeoMeta("/docs/overview/", "global");
      expect(b.description).toBe(a.description);
    });
  });
});
