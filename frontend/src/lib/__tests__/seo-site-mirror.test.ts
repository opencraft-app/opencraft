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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { getSeoMeta, getSiteConfig, SEO_DESCRIPTION, SEO_KEYWORDS } from "@/lib/seo-data";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/generate-static-site.mjs");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

/**
 * route.title 在国际站为 `{ "en-US": ..., "zh-CN": ... }` 双语对象（multi-URL i18n
 * 引入），在国内站仍是字符串。本测试断言「prerender 与 seo-data.ts 一致」时
 * 用各自 region 的默认 locale 字符串作对照——cn 默认 zh-CN，global 默认 en-US。
 */
type StaticRoute = {
  kind: string;
  path: string;
  title: string | { "en-US": string; "zh-CN": string };
};

/** 取 region 默认 locale 下的 title 字符串：cn → 字符串透传；global → en-US 字段 */
function defaultLocaleTitle(title: StaticRoute["title"], region: "cn" | "global"): string {
  if (typeof title === "string") return title;
  return region === "global" ? title["en-US"] : title["zh-CN"];
}

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

async function resolvePrerenderRoutes(region: "cn" | "global"): Promise<StaticRoute[]> {
  const mod = await import(pathToFileURL(SCRIPT_PATH).href) as {
    resolveStaticRoutes: (region: "cn" | "global") => StaticRoute[];
  };
  return mod.resolveStaticRoutes(region);
}

function seoPageTitle(pathname: string, region: "cn" | "global"): string {
  const fullTitle = getSeoMeta(pathname, region).title;
  const suffix = getSeoMeta("/about", region).title.split(" | ")[1];
  if (!suffix) return fullTitle;
  return fullTitle.endsWith(` | ${suffix}`)
    ? fullTitle.slice(0, -` | ${suffix}`.length)
    : fullTitle;
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

describe("prerender route titles mirror seo-data.ts", () => {
  for (const region of ["cn", "global"] as const) {
    it(`${region}: base route titles stay aligned`, async () => {
      const routes = await resolvePrerenderRoutes(region);
      const mirroredRoutes = routes.filter((route) => ["about", "changelog"].includes(route.kind));

      expect(mirroredRoutes.length).toBeGreaterThan(0);
      for (const route of mirroredRoutes) {
        expect(defaultLocaleTitle(route.title, region)).toBe(seoPageTitle(route.path, region));
      }
    });

    it(`${region}: docs route titles stay aligned`, async () => {
      const routes = await resolvePrerenderRoutes(region);
      const docsRoutes = routes.filter((route) => route.kind === "doc");

      expect(docsRoutes.length).toBeGreaterThan(0);
      for (const route of docsRoutes) {
        expect(defaultLocaleTitle(route.title, region)).toBe(seoPageTitle(route.path, region));
      }
    });
  }
});

/**
 * codex CR P1-1 守护：`LOCALIZED_PATH_PREFIXES` 在 `region.ts`（运行时）和
 * `generate-static-site.mjs`（prerender）维护两份。新增公开 SEO 路径时若漏改
 * 一边，会出现"prerender 没产出 /en/X、但运行时 useEnsureLangPrefix 又会重写
 * 到 /en/X"的 404，或反之。这条测试断言两份数组 byte-equal。
 */
/**
 * codex CR P1-4 守护：`DOCS.global` 列表里每个 slug 必须在 `docs/en/` 与
 * `docs/global/` 两个目录都有对应 markdown，否则国际站 prerender 会在
 * `pnpm build:global` 阶段抛 "missing markdown" 直接挂。
 *
 * 这个 fail-fast 检查直接读源码 + fs.exists，不需要跑完整 build，CI 几毫秒
 * 就能反馈，且与 generate-static-site.test.ts 的 fixture 写文件路径互补——
 * fixture 测试只能保证「构造的 fixture 能跑通」，不能保证真实仓库的 md 齐全。
 */
describe("real docs/global markdown coverage matches DOCS.global", () => {
  function extractDocsGlobalFiles(): string[] {
    const block = SCRIPT_SOURCE.match(/global:\s*\[([\s\S]*?)\],\s*\};/);
    expect(block).not.toBeNull();
    const fileMatches = block![1]!.matchAll(/file:\s*"([^"]+)"/g);
    return [...fileMatches].map((m) => m[1]!);
  }

  it("docs/global 与 docs/en 都包含 DOCS.global 的所有 markdown 文件", () => {
    const files = extractDocsGlobalFiles();
    expect(files.length).toBeGreaterThan(10);

    const docsGlobal = path.resolve(process.cwd(), "src/content/docs/global");
    const docsEn = path.resolve(process.cwd(), "src/content/docs/en");
    for (const f of files) {
      expect.soft(
        existsSync(path.join(docsGlobal, f)),
        `missing zh markdown for global build: docs/global/${f}`,
      ).toBe(true);
      expect.soft(
        existsSync(path.join(docsEn, f)),
        `missing en markdown for global build: docs/en/${f}`,
      ).toBe(true);
    }
  });
});

describe("prerender LOCALIZED_PATH_PREFIXES mirror region.ts", () => {
  it("两边数组完全一致（含顺序）", () => {
    /* prerender 一份在 mjs 里写成单行字面量 */
    const mjsMatch = SCRIPT_SOURCE.match(
      /const\s+LOCALIZED_PATH_PREFIXES\s*=\s*\[([^\]]+)\]/,
    );
    expect(mjsMatch).not.toBeNull();
    const mjsList = mjsMatch![1]!
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

    /* 运行时一份在 region.ts 里写成多行字面量 */
    const regionSource = readFileSync(
      path.resolve(process.cwd(), "src/lib/region.ts"),
      "utf8",
    );
    const tsMatch = regionSource.match(
      /LOCALIZED_PATH_PREFIXES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
    );
    expect(tsMatch).not.toBeNull();
    const tsList = tsMatch![1]!
      .split(/[\n,]/)
      .map((s) => s.trim().replace(/^["']|["']$/g, "").replace(/,$/, ""))
      .filter(Boolean);

    expect(mjsList).toEqual(tsList);
  });
});
