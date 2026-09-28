import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";

import { SIDEBAR, SLUG_TO_FILE } from "@/config/docs-sidebar";
import { DOCS_ROUTE_LOCALES, DOCS_ROUTE_SLUGS, isDocsRouteSlug } from "@next-site/docs-route-manifest";

const root = process.cwd();
const retired = [
  "announcements/public-beta",
  "use-cases/telegram-whatsapp-safety-boundaries",
  "use-cases/lifelike-im-agent-rhythm-social-memory",
  "use-cases/im-agent-skill-scenarios",
  "use-cases/whatsapp-24-7-customer-service",
];

describe("temporary public content retirement", () => {
  it("keeps source drafts while removing every published language route and generated page", () => {
    for (const slug of retired) {
      expect(existsSync(join(root, "src/content/docs/global", `${slug}.md`))).toBe(true);
      expect(existsSync(join(root, "src/content/docs/en", `${slug}.md`))).toBe(true);
      for (const locale of DOCS_ROUTE_LOCALES) {
        expect(isDocsRouteSlug(locale, slug.split("/")), `${locale}/${slug}`).toBe(false);
        expect(existsSync(join(root, ".fumadocs-content/docs", locale, `${slug}.mdx`))).toBe(false);
      }
      expect(SLUG_TO_FILE).not.toHaveProperty(slug);
      expect(JSON.stringify(SIDEBAR)).not.toContain(slug);
    }
    expect(existsSync(join(root, "src/content/docs/announcements/public-beta.md"))).toBe(true);
  });

  it("does not leave retired links or outdated billing dates in published MDX and metadata", () => {
    for (const locale of DOCS_ROUTE_LOCALES) {
      for (const parts of DOCS_ROUTE_SLUGS[locale]) {
        if (parts.length === 0) continue;
        const pagePath = join(root, ".fumadocs-content/docs", locale, parts.join("/"));
        const path = existsSync(`${pagePath}.mdx`) ? `${pagePath}.mdx` : join(pagePath, "index.mdx");
        const text = readFileSync(path, "utf8");
        for (const slug of retired) expect(text, path).not.toContain(slug);
        expect(text, path).not.toMatch(/2026\s*年\s*8\s*月\s*18|August 18, 2026|18 (?:de agosto de|Agustus) 2026|2026년 8월 18일/);
        if (["overview", "quickstart", "create-first-hermes", "who-is-lightvela-for", "contact-us", "plans"].includes(parts.join("/"))) {
          expect(text, path).not.toMatch(/公测|内测|\bbeta\b|ベータ|베타/i);
          expect(text, path).not.toMatch(/开启计费后|開啟計費後|after billing starts|setelah penagihan dimulai|después de que comience la facturación|課金開始後|請求が開始された後|청구 시작 후|청구가 시작된 후/i);
        }
      }
    }
  });

  it("restores international Blog navigation while keeping the domestic entry hidden", () => {
    const directory = join(root, "public/lightvela-intl-home");
    for (const file of readdirSync(directory).filter((name) => /^index-fragment.*\.html$/.test(name))) {
      const markup = readFileSync(join(directory, file), "utf8");
      const document = new DOMParser().parseFromString(markup, "text/html");
      const locale = document.querySelector("#lightvela-intl-home")?.getAttribute("data-locale");
      const blogLink = document.querySelector('footer a[href$="/blog"]');
      if (locale === "zh-CN") {
        expect(blogLink, file).toBeNull();
      } else {
        const prefix = locale === "en-US" ? "" : `/${locale?.toLowerCase()}`;
        expect(blogLink?.getAttribute("href"), file).toBe(`${prefix}/blog`);
      }
      expect(markup, file).toContain("/subscribe");
    }
  });

  it("renders both domestic billing durations as strong text without literal Markdown", () => {
    const markdown = readFileSync(join(root, "src/content/docs/plans.md"), "utf8");
    const paragraph = markdown.split("\n").find((line) => line.startsWith("支持 "));
    expect(paragraph).toBeDefined();
    const html = renderToStaticMarkup(<ReactMarkdown>{paragraph}</ReactMarkdown>);
    expect(html).toContain("<strong>月付（1 个月）</strong>");
    expect(html).toContain("<strong>季付（3 个月）</strong>");
    expect(html).not.toContain("**");
  });
});
