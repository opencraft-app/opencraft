// @vitest-environment node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  buildStaticSite,
  resolveStaticRoutes,
} from "./generate-static-site.mjs";

const createFixture = ({ withStaticRenderer = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "static-site-"));
  const frontendRoot = join(root, "frontend");
  const distDir = join(root, "dist");
  if (withStaticRenderer) {
    mkdirSync(join(frontendRoot, "src", "static"), { recursive: true });
    writeFileSync(join(frontendRoot, "src", "static", "logo.png"), "fake image");
    writeFileSync(join(frontendRoot, "src", "static", "render-static-route.tsx"), [
      "export function renderStaticRoute({ route }) {",
      "  if (route.kind !== 'home') return null;",
      "  return '<main data-react-prerendered=\"home\"><h1>React home</h1><img src=\"/src/static/logo.png\"></main>';",
      "}",
    ].join("\n"));
  }
  mkdirSync(join(frontendRoot, "src", "content", "docs", "configuration"), { recursive: true });
  mkdirSync(join(frontendRoot, "src", "content", "docs", "global", "configuration"), { recursive: true });
  mkdirSync(join(frontendRoot, "src", "content", "docs", "en", "configuration"), { recursive: true });
  mkdirSync(join(frontendRoot, "src", "content", "docs", "images"), { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    [
      "<head>",
      "<meta charset=\"UTF-8\">",
      "<title>old</title>",
      "<link rel=\"modulepreload\" crossorigin href=\"/assets/vendor-framework.js\">",
      "<link rel=\"stylesheet\" crossorigin href=\"/assets/index.css\">",
      "<script type=\"module\" crossorigin src=\"/assets/index-test.js\"></script>",
      "</head>",
    ].join(""),
    "<body><div id=\"root\"></div></body>",
    "</html>",
  ].join(""));
  writeFileSync(join(frontendRoot, "src", "content", "docs", "01-overview.md"), [
    "# LightVela 是什么",
    "",
    "LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品。",
    "",
    "## 产品特性",
    "",
    "- 全托管部署",
  ].join("\n"));
  writeFileSync(join(frontendRoot, "src", "content", "docs", "02-quickstart.md"), "# 快速开始\n\n5 分钟跑通第一个对话。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "03-account.md"), "# 账号与实名认证\n\n完成实名认证。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "04-core-concepts.md"), "# 核心概念\n\nHermes、模型、通道、技能。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "05-configuration.md"), "# 配置总览\n\n管理台功能。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "07-faq.md"), "# 常见问题 FAQ\n\n常见问题。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "configuration", "model.md"), "# 配置模型\n\n接入模型 API。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "configuration", "channel-wechat.md"), "# 微信\n\n配置微信通道。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "configuration", "channel-feishu.md"), "# 飞书\n\n配置飞书通道。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "configuration", "channel-qq.md"), "# QQ\n\n配置 QQ 通道。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "configuration", "skill.md"), "# 配置技能\n\n安装技能包。");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "global", "01-overview.md"), "# LightVela 是什么\n\nGlobal Chinese docs.");
  writeFileSync(join(frontendRoot, "src", "content", "docs", "en", "01-overview.md"), "# What is LightVela\n\nCloud-hosted Hermes Agent.");
  return { root, frontendRoot, distDir };
};

describe("generate-static-site", () => {
  it("resolves public route sets by region without indexing app-only routes", () => {
    const cnRoutes = resolveStaticRoutes("cn");
    const globalRoutes = resolveStaticRoutes("global");

    expect(cnRoutes.map((route) => route.path)).toContain("/changelog");
    expect(globalRoutes.map((route) => route.path)).not.toContain("/changelog");
    expect(cnRoutes.map((route) => route.path)).toContain("/docs/configuration/model");
    expect(cnRoutes.map((route) => route.path)).not.toContain("/agents");
  });

  it("generates semantic docs html, sitemap, robots and EdgeOne rewrites", async () => {
    const { root, frontendRoot, distDir } = createFixture();
    try {
      await buildStaticSite({
        frontendRoot,
        distDir,
        region: "cn",
        siteUrl: "https://lightvela.cn",
        indexable: true,
      });

      const docsHtml = readFileSync(join(distDir, "docs", "overview", "index.html"), "utf8");
      expect(docsHtml).toContain("<article");
      expect(docsHtml).toContain("LightVela 是什么");
      expect(docsHtml).toContain("data-static-site-critical");
      expect(docsHtml).toContain(":where(.static-site-main,.static-docs-page)");
      expect(docsHtml).not.toMatch(/(?:^|[{}])main\{/);
      expect(docsHtml).not.toMatch(/(?:^|[{}])h1\{/);
      expect(docsHtml).toContain("<script type=\"module\" crossorigin src=\"/assets/index-test.js\"></script>");
      expect(docsHtml).toContain("<link rel=\"stylesheet\" crossorigin href=\"/assets/index.css\">");
      expect(docsHtml).toContain("aria-label=\"文档导航\"");
      expect(docsHtml).toContain("aria-label=\"本文目录\"");
      expect(docsHtml).toContain("\"@type\":\"TechArticle\"");
      expect(docsHtml).toContain("<link rel=\"canonical\" href=\"https://lightvela.cn/docs/overview\"");

      const docsIndexHtml = readFileSync(join(distDir, "docs", "index.html"), "utf8");
      expect(docsIndexHtml).toContain("<link rel=\"canonical\" href=\"https://lightvela.cn/docs/overview\"");

      const appHtml = readFileSync(join(distDir, "app.html"), "utf8");
      expect(appHtml).toContain("<meta name=\"robots\" content=\"noindex,nofollow\"");
      expect(appHtml).toContain("正在恢复会话...");
      expect(appHtml).toContain("<script type=\"module\" crossorigin src=\"/assets/index-test.js\"></script>");
      expect(appHtml).not.toContain("data-static-site-critical");
      expect(appHtml).not.toContain("能帮我做什么");

      const agentsHtml = readFileSync(join(distDir, "agents", "index.html"), "utf8");
      expect(agentsHtml).toContain("正在恢复会话...");
      expect(agentsHtml).not.toContain("能帮我做什么");

      const sitemap = readFileSync(join(distDir, "sitemap.xml"), "utf8");
      expect(sitemap).toContain("<loc>https://lightvela.cn/docs/configuration/model</loc>");
      expect(sitemap).not.toContain("/agents");

      const robots = readFileSync(join(distDir, "robots.txt"), "utf8");
      expect(robots).toContain("Allow: /");
      expect(robots).toContain("Sitemap: https://lightvela.cn/sitemap.xml");

      const edgeone = JSON.parse(readFileSync(join(distDir, "edgeone.json"), "utf8"));
      expect(edgeone.rewrites).toContainEqual({ source: "/agents/*", destination: "/app.html" });
      expect(edgeone.rewrites).toContainEqual({ source: "/account", destination: "/app.html" });
      expect(edgeone.rewrites).toContainEqual({ source: "/account/*", destination: "/app.html" });
      expect(edgeone.rewrites).not.toContainEqual({ source: "/*", destination: "/index.html" });

      const redirects = readFileSync(join(distDir, "_redirects"), "utf8");
      expect(redirects).toContain("/agents/* /agents/ 200");
      expect(redirects).toContain("/account/* /account/ 200");
      expect(redirects).not.toContain("/app.html");
      expect(redirects.split("\n")).not.toContain("/* /agents 200");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the React static renderer for the home page when available", async () => {
    const { root, frontendRoot, distDir } = createFixture({ withStaticRenderer: true });
    try {
      await buildStaticSite({
        frontendRoot,
        distDir,
        region: "cn",
        siteUrl: "https://lightvela.cn",
        indexable: true,
      });

      const homeHtml = readFileSync(join(distDir, "index.html"), "utf8");
      expect(homeHtml).toContain("data-react-prerendered=\"home\"");
      expect(homeHtml).toContain("<h1>React home</h1>");
      expect(homeHtml).toContain("/assets/static-render/static/logo.png");
      expect(existsSync(join(distDir, "assets", "static-render", "static", "logo.png"))).toBe(true);
      expect(homeHtml).not.toContain("能帮我做什么");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits both /en and /zh trees with hreflang on global region", async () => {
    const { root, frontendRoot, distDir } = createFixture();
    try {
      /* 国际站需要 docs/global 中文 markdown 真实存在；fixture 默认只放了 overview，
         补一份 quickstart 让 docs/quickstart/index.html 也能渲染（避免缺文件抛错） */
      writeFileSync(join(frontendRoot, "src", "content", "docs", "global", "02-quickstart.md"), "# 快速开始\n\nGlobal 中文 quickstart.");
      writeFileSync(join(frontendRoot, "src", "content", "docs", "global", "04-core-concepts.md"), "# 核心概念\n\nGlobal 中文 core concepts.");
      writeFileSync(join(frontendRoot, "src", "content", "docs", "global", "05-configuration.md"), "# 配置总览\n\nGlobal 中文 configuration.");
      writeFileSync(join(frontendRoot, "src", "content", "docs", "global", "07-faq.md"), "# 常见问题 FAQ\n\nGlobal 中文 faq.");
      writeFileSync(join(frontendRoot, "src", "content", "docs", "en", "02-quickstart.md"), "# Quickstart\n\nGet started in 5 minutes.");
      writeFileSync(join(frontendRoot, "src", "content", "docs", "en", "04-core-concepts.md"), "# Core Concepts\n\nHermes, models, channels, skills.");
      writeFileSync(join(frontendRoot, "src", "content", "docs", "en", "05-configuration.md"), "# Configuration Overview\n\nConsole walkthrough.");
      writeFileSync(join(frontendRoot, "src", "content", "docs", "en", "07-faq.md"), "# FAQ\n\nFrequently asked questions.");
      /* configuration/* 文档也需补齐两个 locale 各一份 */
      mkdirSync(join(frontendRoot, "src", "content", "docs", "global", "configuration"), { recursive: true });
      mkdirSync(join(frontendRoot, "src", "content", "docs", "en", "configuration"), { recursive: true });
      mkdirSync(join(frontendRoot, "src", "content", "docs", "global", "faq"), { recursive: true });
      mkdirSync(join(frontendRoot, "src", "content", "docs", "en", "faq"), { recursive: true });
      const docFiles = [
        "configuration/model.md",
        "configuration/channel-wechat.md",
        "configuration/channel-telegram.md",
        "configuration/channel-whatsapp.md",
        "configuration/channel-discord.md",
        "configuration/channel-qq.md",
        "configuration/channel-wecom.md",
        "configuration/channel-feishu.md",
        "configuration/skill.md",
        "configuration/automation.md",
        "configuration/agent-chat.md",
        "faq/using-lightvela-safely.md",
      ];
      for (const f of docFiles) {
        writeFileSync(join(frontendRoot, "src", "content", "docs", "global", f), `# 中文 ${f}\n\n中文内容。`);
        writeFileSync(join(frontendRoot, "src", "content", "docs", "en", f), `# English ${f}\n\nEnglish content.`);
      }

      await buildStaticSite({
        frontendRoot,
        distDir,
        region: "global",
        siteUrl: "https://lightvela.ai",
        indexable: true,
      });

      /* 两套树都被生成 */
      const enOverview = readFileSync(join(distDir, "en", "docs", "overview", "index.html"), "utf8");
      const zhOverview = readFileSync(join(distDir, "zh", "docs", "overview", "index.html"), "utf8");
      expect(enOverview).toContain("What is LightVela");
      expect(zhOverview).toContain("LightVela 是什么");

      /* <html lang> 跟随 locale 切换 */
      expect(enOverview).toMatch(/<html\s+lang="en-US">/);
      expect(zhOverview).toMatch(/<html\s+lang="zh-CN">/);

      /* hreflang 互相指向且包含 x-default */
      expect(enOverview).toContain("<link rel=\"alternate\" hreflang=\"en\" href=\"https://lightvela.ai/en/docs/overview\">");
      expect(enOverview).toContain("<link rel=\"alternate\" hreflang=\"zh\" href=\"https://lightvela.ai/zh/docs/overview\">");
      expect(enOverview).toContain("<link rel=\"alternate\" hreflang=\"x-default\" href=\"https://lightvela.ai/en/docs/overview\">");

      /* sitemap 同时包含 /en/ 和 /zh/ URL，并带 xhtml hreflang */
      const sitemap = readFileSync(join(distDir, "sitemap.xml"), "utf8");
      expect(sitemap).toContain("xmlns:xhtml=\"http://www.w3.org/1999/xhtml\"");
      expect(sitemap).toContain("<loc>https://lightvela.ai/en/docs/configuration/model</loc>");
      expect(sitemap).toContain("<loc>https://lightvela.ai/zh/docs/configuration/model</loc>");
      expect(sitemap).toContain("<xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://lightvela.ai/en/docs/configuration/model\"/>");
      expect(sitemap).toContain("<xhtml:link rel=\"alternate\" hreflang=\"zh\" href=\"https://lightvela.ai/zh/docs/configuration/model\"/>");
      expect(sitemap).toContain("<xhtml:link rel=\"alternate\" hreflang=\"x-default\"");
      /* 不包含「无前缀」doc URL（避免与多语言版本冲突） */
      expect(sitemap).not.toMatch(/<loc>https:\/\/lightvela\.ai\/docs\/configuration\/model<\/loc>/);

      /* docs sidebar 内部链接包含语言前缀 */
      expect(enOverview).toMatch(/href="\/en\/docs\/configuration\/model"/);
      expect(zhOverview).toMatch(/href="\/zh\/docs\/configuration\/model"/);

      /* 国际站不应输出无前缀的 docs HTML（旧行为下生成的 /docs/overview/index.html 不再存在） */
      expect(existsSync(join(distDir, "docs", "overview", "index.html"))).toBe(false);

      /* P1-a：vite 留下的中文 dist/index.html 必须被覆盖为指向 /en/ 的别名页。
         - canonical 指 /en/，让 Google 把权重收敛到带前缀版本
         - hreflang 集群完整，把 /、/en/、/zh/ 收成一组
         - <html lang> 不再是中文 zh-CN（旧 vite 模板的 lang），而是 en-US */
      const rootIndex = readFileSync(join(distDir, "index.html"), "utf8");
      expect(rootIndex).not.toMatch(/<title>old<\/title>/); // 旧 vite 模板已被覆盖
      expect(rootIndex).toMatch(/<html\s+lang="en-US">/);
      expect(rootIndex).toContain("<link rel=\"canonical\" href=\"https://lightvela.ai/en/\">");
      expect(rootIndex).toContain("<link rel=\"alternate\" hreflang=\"en\" href=\"https://lightvela.ai/en/\">");
      expect(rootIndex).toContain("<link rel=\"alternate\" hreflang=\"zh\" href=\"https://lightvela.ai/zh/\">");
      expect(rootIndex).toContain("<link rel=\"alternate\" hreflang=\"x-default\" href=\"https://lightvela.ai/en/\">");

      /* P2：/zh/docs 产物 sidebar / breadcrumb 用中文标题，与 <html lang="zh-CN"> 匹配 */
      const zhConfig = readFileSync(join(distDir, "zh", "docs", "configuration", "model", "index.html"), "utf8");
      expect(zhConfig).toContain("配置指南"); // sidebar group title
      expect(zhConfig).toContain("配置模型"); // sidebar item title + breadcrumb leaf
      expect(zhConfig).not.toContain("Configuration Guide"); // 英文不应泄漏到 zh 产物的 crawl-visible 区域
      const enConfig = readFileSync(join(distDir, "en", "docs", "configuration", "model", "index.html"), "utf8");
      expect(enConfig).toContain("Configuration Guide");
      expect(enConfig).toContain("Configure Models");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks preview output as noindex", async () => {
    const { root, frontendRoot, distDir } = createFixture();
    try {
      await buildStaticSite({
        frontendRoot,
        distDir,
        region: "cn",
        siteUrl: "https://preview.lightclaw.tech",
        indexable: false,
      });

      const html = readFileSync(join(distDir, "index.html"), "utf8");
      expect(html).toContain("<meta name=\"robots\" content=\"noindex,nofollow\"");
      expect(readFileSync(join(distDir, "robots.txt"), "utf8")).toContain("Disallow: /");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
