/**
 * 镜像守护测试：generate-static-site.mjs（构建期 prerender）与 seo-data.ts
 * （运行时 / dev 中间件）维护两份重复的站点级 SEO 常量——
 *
 *   - SITE.{cn,global}.{lang, locale, name, defaultUrl, titleSuffix, description}
 *   - SITE_KEYWORDS.{cn,global}
 *
 * 之所以不直接共享：generate-static-site.mjs 是纯 Node `.mjs` 入口，
 * 在 vite/tsx 引导前运行（`pnpm static-site:cn`），无法 import 本 TS 模块。
 *
 * 因此本测试在 CI 中守护两边一致，避免一边改了文案另一边漏改造成线上 SEO
 * 与开发态出现漂移（典型事故：CR4 之前国际站 description 被改了 prerender，
 * 但 dev 中间件还跑老文案）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSeoMeta, getSiteConfig, SEO_DESCRIPTION, SEO_KEYWORDS } from "@/lib/seo-data";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/generate-static-site.mjs");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

/**
 * 从 generate-static-site.mjs 源码里抽取一个简单字面量字段。
 * prerender 脚本的 SITE / SITE_KEYWORDS 都是顶层字面量对象，
 * 字段值都是单行字符串（`"..."`），用正则就足够稳定。
 */
function extractStringField(source: string, blockHeader: RegExp, field: string): string {
  const block = source.match(blockHeader);
  if (!block) throw new Error(`block not found: ${blockHeader}`);
  const slice = source.slice(block.index ?? 0);
  const fieldPattern = new RegExp(`${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = slice.match(fieldPattern);
  if (!match) throw new Error(`field not found: ${field} in block ${blockHeader}`);
  // 还原 JSON 字符串转义（`\"`、`\\` 等）
  return JSON.parse(`"${match[1]}"`);
}

describe("prerender SITE constants mirror seo-data.ts", () => {
  for (const region of ["cn", "global"] as const) {
    describe(region, () => {
      const blockHeader = region === "cn" ? /\bcn:\s*\{/ : /\bglobal:\s*\{/;

      it("lang matches", () => {
        const prerender = extractStringField(SCRIPT_SOURCE, blockHeader, "lang");
        expect(prerender).toBe(getSiteConfig(region).htmlLang);
      });

      it("locale matches", () => {
        const prerender = extractStringField(SCRIPT_SOURCE, blockHeader, "locale");
        expect(prerender).toBe(getSiteConfig(region).locale);
      });

      it("name matches", () => {
        const prerender = extractStringField(SCRIPT_SOURCE, blockHeader, "name");
        expect(prerender).toBe(getSiteConfig(region).siteName);
      });

      it("defaultUrl matches", () => {
        const prerender = extractStringField(SCRIPT_SOURCE, blockHeader, "defaultUrl");
        expect(prerender).toBe(getSiteConfig(region).defaultUrl);
      });

      it("titleSuffix matches", () => {
        const prerender = extractStringField(SCRIPT_SOURCE, blockHeader, "titleSuffix");
        // seo-data 里 titleSuffix 嵌进 title：`${pageTitle} | ${suffix}`
        // 取一个非首页路径反推 suffix
        const meta = getSeoMeta("/about", region);
        const suffix = meta.title.split(" | ")[1];
        expect(prerender).toBe(suffix);
      });

      it("description matches", () => {
        const prerender = extractStringField(SCRIPT_SOURCE, blockHeader, "description");
        const expected = region === "cn" ? SEO_DESCRIPTION : getSeoMeta("/", region).description;
        expect(prerender).toBe(expected);
      });
    });
  }
});

describe("prerender SITE_KEYWORDS mirror seo-data.ts", () => {
  it("cn keywords match", () => {
    const block = SCRIPT_SOURCE.match(/SITE_KEYWORDS\s*=\s*\{[\s\S]*?\};/);
    expect(block).not.toBeNull();
    const cn = extractStringField(block![0], /^/, "cn");
    expect(cn).toBe(SEO_KEYWORDS);
  });

  it("global keywords match", () => {
    const block = SCRIPT_SOURCE.match(/SITE_KEYWORDS\s*=\s*\{[\s\S]*?\};/);
    expect(block).not.toBeNull();
    const global = extractStringField(block![0], /^/, "global");
    expect(global).toBe(getSeoMeta("/", "global").keywords);
  });
});
