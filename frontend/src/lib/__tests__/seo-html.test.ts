/**
 * 回归测试：SEO HTML 注入的转义安全性。
 * 对应 CR 整改点 2（`$` 元字符注入）与 3（title 文本转义不应转 `"`）。
 */
import { describe, expect, it } from "vitest";
import {
  applySeoToHtml,
  escapeHtmlAttribute,
  escapeHtmlText,
  replaceOrInsertMeta,
} from "@/lib/seo-html";

const TEMPLATE = `<!doctype html><html><head><title>OLD</title></head><body></body></html>`;

describe("seo-html escaping", () => {
  it("CR3: text escape keeps double quotes intact (no &quot; in <title>)", () => {
    // 文本上下文不应转义 `"`，否则会被爬虫原样收录污染标题。
    expect(escapeHtmlText('A "quoted" title')).toBe('A "quoted" title');
    // 但仍要转义 `<` / `>` / `&`。
    expect(escapeHtmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("attribute escape still encodes double quotes", () => {
    expect(escapeHtmlAttribute('x "y" z')).toBe("x &quot;y&quot; z");
  });

  it("CR2: meta content containing `$` is not treated as replacement pattern", () => {
    // `$&` / `$1` / `$$` 若走字符串版 replace 会被当作特殊替换模式 → 内容被破坏。
    // 这里同时包含 `$` 元字符 与 `&`（属性里必须被转义为 `&amp;`）：
    //   - `$1` / `$$` 应原样保留（不被解释为捕获组 / 字面 `$`）
    //   - `$&` 中的 `&` 必须转成 `&amp;`，但 `$` 不应丢失
    const tricky = "price $1 and $$ and $& literal";
    const out = replaceOrInsertMeta(
      `<head><meta name="description" content="OLD" /><title>T</title></head>`,
      "description",
      tricky,
    );
    // 期望属性值：`$1` 原样、`$$` 原样、`&` → `&amp;`（`$` 保留）
    expect(out).toContain('content="price $1 and $$ and $&amp; literal"');
    // 反向断言：不应被误当作 "整个匹配" 而把 `$&` 整体丢失或替换成上一次匹配的子串
    expect(out).not.toContain("price $1 and $$ and  literal"); // 整个 `$&` 被吞
    expect(out).not.toMatch(/content="price \$1 and \$\$ and OLD/); // `$&` 被解释成上次匹配
  });

  it("CR2/CR3: applySeoToHtml injects title as text without quote-escaping", () => {
    const html = applySeoToHtml(TEMPLATE, "/docs/overview", "global");
    // 国际站 overview 标题含 `·`，且后缀无引号，应原样注入。
    expect(html).toContain(
      "<title>What is LightVela | LightVela · Your Personal Cloud AI Agent</title>",
    );
    expect(html).not.toContain("&quot;");
  });

  it("inserts meta before <title> when missing", () => {
    const out = replaceOrInsertMeta(`<head><title>T</title></head>`, "keywords", "a, b, c");
    expect(out).toContain('<meta name="keywords" content="a, b, c" />');
    expect(out.indexOf("keywords")).toBeLessThan(out.indexOf("<title>"));
  });

  it("matches meta tags regardless of attribute order and does not duplicate them", () => {
    const out = replaceOrInsertMeta(
      `<head><meta content="OLD" data-source="fixture" name = "description"><title>T</title></head>`,
      "description",
      "next",
    );

    expect(out).toContain('<meta name="description" content="next" />');
    expect(out).not.toContain('content="OLD"');
    expect(out.match(/name="description"/g) ?? []).toHaveLength(1);
  });

  it("deduplicates repeated matching meta tags while replacing the first one", () => {
    const out = replaceOrInsertMeta(
      [
        "<head>",
        '<meta name="description" content="OLD1">',
        '<meta content="OLD2" name="description">',
        "<title>T</title>",
        "</head>",
      ].join(""),
      "description",
      "next",
    );

    expect(out.match(/name="description"/g) ?? []).toHaveLength(1);
    expect(out).toContain('<meta name="description" content="next" />');
    expect(out).not.toContain("OLD1");
    expect(out).not.toContain("OLD2");
  });
});
