/**
 * 完整 SEO 注入回归测试：dev 中间件管线必须输出与 prerender 对齐的字段集。
 *
 * 守护字段：
 *   - <html lang>（按 region 切换）
 *   - <title>
 *   - <meta name="description"|"keywords"|"robots">
 *   - <link rel="canonical">
 *   - Open Graph：og:locale / og:type / og:site_name / og:title / og:description / og:url / og:image
 *   - Twitter Card：twitter:card / twitter:title / twitter:description / twitter:image
 */
import { describe, expect, it } from "vitest";
import { applyFullSeoToHtml } from "@/lib/seo-html";

const TEMPLATE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="OLD" />
    <meta name="keywords" content="OLD" />
    <title>OLD</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("applyFullSeoToHtml", () => {
  it("injects all required SEO fields for cn region", () => {
    const html = applyFullSeoToHtml(TEMPLATE, "/about", "cn");

    // <html lang>
    expect(html).toMatch(/<html\s+lang="zh-CN">/);

    // <title> + meta description / keywords / robots
    expect(html).toContain("<title>关于我们 | LightVela 云端专属个人 Agent</title>");
    // /about 页使用页面级 description（与全站默认不同），匹配其稳定前缀。
    expect(html).toMatch(/<meta name="description" content="LightVela 由腾讯轻量云团队/);
    expect(html).toMatch(/<meta name="keywords" content="LightVela, /);
    expect(html).toContain('<meta name="robots" content="index,follow"');

    // canonical
    expect(html).toContain('<link rel="canonical" href="https://lightvela.com/about"');

    // Open Graph
    expect(html).toContain('<meta property="og:locale" content="zh_CN"');
    expect(html).toContain('<meta property="og:type" content="website"');
    expect(html).toContain('<meta property="og:site_name" content="LightVela"');
    expect(html).toContain(
      '<meta property="og:title" content="关于我们 | LightVela 云端专属个人 Agent"',
    );
    expect(html).toContain('<meta property="og:url" content="https://lightvela.com/about"');
    expect(html).toContain(
      '<meta property="og:image" content="https://lightvela.com/lightvela-logo.jpg"',
    );

    // Twitter Card
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain(
      '<meta name="twitter:title" content="关于我们 | LightVela 云端专属个人 Agent"',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://lightvela.com/lightvela-logo.jpg"',
    );
  });

  it("switches html lang and locale for global region", () => {
    const html = applyFullSeoToHtml(TEMPLATE, "/about", "global");

    expect(html).toMatch(/<html\s+lang="en-US">/);
    expect(html).toContain('<meta property="og:locale" content="en_US"');
    expect(html).toContain(
      "<title>About LightVela | LightVela · Your Personal Cloud AI Agent</title>",
    );
    expect(html).toContain('<link rel="canonical" href="https://lightvela.ai/about"');
    expect(html).toContain(
      '<meta property="og:image" content="https://lightvela.ai/lightvela-logo.jpg"',
    );
  });

  it("honors siteUrl override (dev / preview environments)", () => {
    const html = applyFullSeoToHtml(TEMPLATE, "/docs/overview", "cn", {
      siteUrl: "http://localhost:5174",
    });
    expect(html).toContain('<link rel="canonical" href="http://localhost:5174/docs/overview"');
    expect(html).toContain('<meta property="og:url" content="http://localhost:5174/docs/overview"');
    expect(html).toContain(
      '<meta property="og:image" content="http://localhost:5174/lightvela-logo.jpg"',
    );
  });

  it("marks private routes as noindex,nofollow by default", () => {
    expect(applyFullSeoToHtml(TEMPLATE, "/auth/sign-in", "cn")).toContain(
      '<meta name="robots" content="noindex,nofollow"',
    );
    expect(applyFullSeoToHtml(TEMPLATE, "/account/orders", "cn")).toContain(
      '<meta name="robots" content="noindex,nofollow"',
    );
    expect(applyFullSeoToHtml(TEMPLATE, "/dashboard/setup", "cn")).toContain(
      '<meta name="robots" content="noindex,nofollow"',
    );
    // 公共路径仍应可索引
    expect(applyFullSeoToHtml(TEMPLATE, "/about", "cn")).toContain(
      '<meta name="robots" content="index,follow"',
    );
  });

  it("indexable=false override forces noindex even for public paths", () => {
    expect(
      applyFullSeoToHtml(TEMPLATE, "/about", "cn", { indexable: false }),
    ).toContain('<meta name="robots" content="noindex,nofollow"');
  });

  it("does not double-encode title quotes (CR3 invariant preserved)", () => {
    const html = applyFullSeoToHtml(TEMPLATE, "/docs/overview", "global");
    // <title> 文本上下文不该出现 &quot;
    const titleMatch = html.match(/<title>(.*?)<\/title>/);
    expect(titleMatch?.[1]).not.toContain("&quot;");
  });

  it("escapes attribute values (canonical with `&` produces `&amp;`)", () => {
    const html = applyFullSeoToHtml(TEMPLATE, "/about", "cn", {
      siteUrl: "https://example.com/path?a=1&b=2",
    });
    // canonical 是 origin 拼路径，`?a=1&b=2` 在 trim 处理后被去除，这里用一个含 `&` 的
    // 自定义 ogImagePath 验证转义路径。
    const html2 = applyFullSeoToHtml(TEMPLATE, "/about", "cn", {
      ogImagePath: "/img.jpg?v=1&x=2",
    });
    expect(html2).toContain('content="https://lightvela.com/img.jpg?v=1&amp;x=2"');
    // 原 canonical（不含 `?` query 因为 trimTrailingSlash 不会动 query）依旧被正确写入
    expect(html).toContain("<link rel=\"canonical\"");
  });

  it("upserts og tags when template has none", () => {
    const minimal = `<!doctype html><html><head><title>OLD</title></head><body></body></html>`;
    const out = applyFullSeoToHtml(minimal, "/about", "cn");
    // 缺失的 og:* 应被注入到 <title> 之前
    const ogIndex = out.indexOf('property="og:title"');
    const titleIndex = out.indexOf("<title>");
    expect(ogIndex).toBeGreaterThan(-1);
    expect(ogIndex).toBeLessThan(titleIndex);
  });

  it("replaces existing meta in place when present (no duplicates)", () => {
    const out = applyFullSeoToHtml(TEMPLATE, "/about", "cn");
    const descCount = (out.match(/<meta name="description"/g) ?? []).length;
    const keywordsCount = (out.match(/<meta name="keywords"/g) ?? []).length;
    expect(descCount).toBe(1);
    expect(keywordsCount).toBe(1);
  });
});
