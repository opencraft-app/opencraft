import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  buildStaticSite,
  resolveStaticRoutes,
} from "./generate-static-site.mjs";

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "static-site-"));
  const frontendRoot = join(root, "frontend");
  const distDir = join(root, "dist");
  mkdirSync(join(frontendRoot, "src", "content", "docs", "configuration"), { recursive: true });
  mkdirSync(join(frontendRoot, "src", "content", "docs", "global", "configuration"), { recursive: true });
  mkdirSync(join(frontendRoot, "src", "content", "docs", "en", "configuration"), { recursive: true });
  mkdirSync(join(frontendRoot, "src", "content", "docs", "images"), { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head><meta charset=\"UTF-8\"><title>old</title></head>",
    "<body><div id=\"root\"></div><script type=\"module\" src=\"/assets/index.js\"></script></body>",
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
      expect(docsHtml).toContain("aria-label=\"文档导航\"");
      expect(docsHtml).toContain("aria-label=\"本文目录\"");
      expect(docsHtml).toContain("\"@type\":\"TechArticle\"");
      expect(docsHtml).toContain("<link rel=\"canonical\" href=\"https://lightvela.cn/docs/overview\"");

      const docsIndexHtml = readFileSync(join(distDir, "docs", "index.html"), "utf8");
      expect(docsIndexHtml).toContain("<link rel=\"canonical\" href=\"https://lightvela.cn/docs/overview\"");

      const sitemap = readFileSync(join(distDir, "sitemap.xml"), "utf8");
      expect(sitemap).toContain("<loc>https://lightvela.cn/docs/configuration/model</loc>");
      expect(sitemap).not.toContain("/agents");

      const robots = readFileSync(join(distDir, "robots.txt"), "utf8");
      expect(robots).toContain("Allow: /");
      expect(robots).toContain("Sitemap: https://lightvela.cn/sitemap.xml");

      const edgeone = JSON.parse(readFileSync(join(distDir, "edgeone.json"), "utf8"));
      expect(edgeone.rewrites).toContainEqual({ source: "/agents/*", destination: "/index.html" });
      expect(edgeone.rewrites).not.toContainEqual({ source: "/*", destination: "/index.html" });
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
