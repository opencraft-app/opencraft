import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultFrontendRoot = resolve(scriptDir, "..");
const STATIC_RENDER_ASSET_EXTENSIONS = new Set([".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);

const SITE = {
  cn: {
    lang: "zh-CN",
    locale: "zh_CN",
    name: "LightVela",
    defaultUrl: "https://lightvela.com",
    titleSuffix: "LightVela 云端专属个人 Agent",
    description: "LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴——不是每次打开都要重新自我介绍的工具，而是认识你、记得你、越聊越懂你的长期存在。",
  },
  global: {
    lang: "en-US",
    locale: "en_US",
    name: "LightVela",
    defaultUrl: "https://lightvela.ai",
    titleSuffix: "LightVela 云端专属个人 Agent",
    description: "LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴——不是每次打开都要重新自我介绍的工具，而是认识你、记得你、越聊越懂你的长期存在。",
  },
};

const SITE_KEYWORDS = "LightVela, LightVela Agent, 云端 Agent, 个人 Agent, AI 伙伴, 腾讯轻量云, Agent 托管, 长期记忆, 个性化 AI, Hermes Agent, OpenClaw, 智能助手, AI 助手, 自动任务, 多渠道接入, QQ 机器人, 微信 Agent, 企业微信 Agent, 飞书 Agent, AI 陪伴, 个人智能体";

const DOCS = {
  cn: [
    { slug: "overview", title: "LightVela 是什么", file: "01-overview.md", group: "开始使用" },
    { slug: "quickstart", title: "快速开始", file: "02-quickstart.md", group: "开始使用" },
    { slug: "account", title: "账号与实名认证", file: "03-account.md", group: "开始使用" },
    { slug: "core-concepts", title: "核心概念", file: "04-core-concepts.md", group: "开始使用" },
    { slug: "configuration", title: "配置总览", file: "05-configuration.md", group: "配置指南" },
    { slug: "configuration/model", title: "配置模型", file: "configuration/model.md", group: "配置指南" },
    { slug: "configuration/channel-wechat", title: "微信", file: "configuration/channel-wechat.md", group: "配置指南" },
    { slug: "configuration/channel-feishu", title: "飞书", file: "configuration/channel-feishu.md", group: "配置指南" },
    { slug: "configuration/channel-qq", title: "QQ", file: "configuration/channel-qq.md", group: "配置指南" },
    { slug: "configuration/skill", title: "配置技能", file: "configuration/skill.md", group: "配置指南" },
    { slug: "faq", title: "常见问题 FAQ", file: "07-faq.md", group: "参考" },
  ],
  global: [
    { slug: "overview", title: "What is LightVela", file: "01-overview.md", group: "Getting Started" },
    { slug: "quickstart", title: "Quickstart", file: "02-quickstart.md", group: "Getting Started" },
    { slug: "core-concepts", title: "Core Concepts", file: "04-core-concepts.md", group: "Getting Started" },
    { slug: "configuration", title: "Configuration Overview", file: "05-configuration.md", group: "Configuration Guide" },
    { slug: "configuration/model", title: "Configure Models", file: "configuration/model.md", group: "Configuration Guide" },
    { slug: "configuration/channel-wechat", title: "WeChat", file: "configuration/channel-wechat.md", group: "Configuration Guide" },
    { slug: "configuration/channel-telegram", title: "Telegram", file: "configuration/channel-telegram.md", group: "Configuration Guide" },
    { slug: "configuration/channel-whatsapp", title: "WhatsApp", file: "configuration/channel-whatsapp.md", group: "Configuration Guide" },
    { slug: "configuration/channel-discord", title: "Discord", file: "configuration/channel-discord.md", group: "Configuration Guide" },
    { slug: "configuration/channel-qq", title: "QQ", file: "configuration/channel-qq.md", group: "Configuration Guide" },
    { slug: "configuration/channel-wecom", title: "WeCom", file: "configuration/channel-wecom.md", group: "Configuration Guide" },
    { slug: "configuration/channel-feishu", title: "Lark", file: "configuration/channel-feishu.md", group: "Configuration Guide" },
    { slug: "configuration/skill", title: "Configure Skills", file: "configuration/skill.md", group: "Configuration Guide" },
    { slug: "configuration/automation", title: "Automations", file: "configuration/automation.md", group: "Configuration Guide" },
    { slug: "configuration/agent-chat", title: "Chat", file: "configuration/agent-chat.md", group: "Configuration Guide" },
    { slug: "faq", title: "FAQ", file: "07-faq.md", group: "Reference" },
    { slug: "faq/using-lightvela-safely", title: "Using LightVela Safely", file: "faq/using-lightvela-safely.md", group: "Reference" },
  ],
};

const SPA_REWRITES = [
  "/agents",
  "/agents/*",
  "/account",
  "/account/*",
  "/bots/*",
  "/settings/*",
  "/auth/*",
  "/plans/*",
  "/tat/*",
  "/subscribe",
  "/dashboard/*",
  "/openclaw/*",
  "/console/*",
];

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const slugifyHeading = (value) => encodeURIComponent(
  value
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{Letter}\p{Number}\s-]+/gu, "")
    .replace(/\s+/g, "-"),
);

const normalizeSiteUrl = (value) => value.replace(/\/+$/, "");
const absoluteUrl = (siteUrl, path) => `${normalizeSiteUrl(siteUrl)}${path === "/" ? "" : path}`;
const outputPathForRoute = (distDir, path) => path === "/"
  ? join(distDir, "index.html")
  : join(distDir, ...path.replace(/^\/+/, "").split("/"), "index.html");

const appShellPathFromRewrite = (source) => {
  const normalized = source.replace(/\/\*$/, "").replace(/\/+$/, "") || "/";
  return normalized === "/" ? null : normalized;
};

const plainText = (markdown) => markdown
  .replace(/```[\s\S]*?```/g, " ")
  .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
  .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
  .replace(/[*_`>#|~-]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const truncateDescription = (text, fallback) => {
  const clean = plainText(text);
  if (!clean) return fallback;
  return clean.length > 155 ? `${clean.slice(0, 152)}...` : clean;
};

function readExistingIndex(distDir) {
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`missing Vite index template: ${indexPath}`);
  }
  return readFileSync(indexPath, "utf8");
}

function docsRootForRegion(frontendRoot, region) {
  if (region === "global") return join(frontendRoot, "src", "content", "docs", "en");
  return join(frontendRoot, "src", "content", "docs");
}

function fallbackDocsRootForRegion(frontendRoot, region) {
  if (region === "global") return join(frontendRoot, "src", "content", "docs", "global");
  return null;
}

function readDocMarkdown(frontendRoot, region, doc) {
  const primary = join(docsRootForRegion(frontendRoot, region), doc.file);
  if (existsSync(primary)) return readFileSync(primary, "utf8");
  const fallbackRoot = fallbackDocsRootForRegion(frontendRoot, region);
  if (fallbackRoot) {
    const fallback = join(fallbackRoot, doc.file);
    if (existsSync(fallback)) return readFileSync(fallback, "utf8");
  }
  return null;
}

function collectPublicImages(sourceDir) {
  if (!existsSync(sourceDir)) return [];
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile()) entries.push(path);
    }
  };
  walk(sourceDir);
  return entries;
}

function copyDocsImages(frontendRoot, distDir) {
  const sourceDir = join(frontendRoot, "src", "content", "docs", "images");
  const targetDir = join(distDir, "assets", "docs-images");
  rmSync(targetDir, { recursive: true, force: true });
  const images = collectPublicImages(sourceDir);
  for (const imagePath of images) {
    const relativePath = relative(sourceDir, imagePath);
    const targetPath = join(targetDir, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(imagePath, targetPath);
  }
  return new Set(images.map((imagePath) => relative(sourceDir, imagePath)));
}

function resolveDocsImageUrl(fname, region, availableImages = new Set()) {
  const cleanName = fname.replace(/^\.?\//, "").replace(/^images\//, "");
  if (region === "global" && !/-en\.[^.]+$/.test(cleanName)) {
    const localized = cleanName.replace(/(\.[^.]+)$/, "-en$1");
    if (availableImages.has(localized)) {
      return `/assets/docs-images/${localized}`;
    }
  }
  return `/assets/docs-images/${cleanName}`;
}

function rewriteMarkdownLinks(markdown) {
  return markdown.replace(/\]\(([^)]+)\)/g, (match, url) => {
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) return match;
    if (!/\.md($|#)/.test(url)) return match;

    let nextUrl = url.replace(/^\.\//, "").replace(/^\.\.\//, "");
    let hash = "";
    const hashIndex = nextUrl.indexOf("#");
    if (hashIndex >= 0) {
      hash = nextUrl.slice(hashIndex);
      nextUrl = nextUrl.slice(0, hashIndex);
    }
    nextUrl = nextUrl.replace(/\.md$/, "");
    const map = {
      "01-overview": "overview",
      "02-quickstart": "quickstart",
      "03-account": "account",
      "04-core-concepts": "core-concepts",
      "05-configuration": "configuration",
      "07-faq": "faq",
    };
    return `](/docs/${map[nextUrl] ?? nextUrl}${hash})`;
  });
}

function inlineMarkdown(value, region, availableImages) {
  let output = escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, (_, text, href) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`)
    .replace(/!\[([^\]]*)]\((?:\.\/|\.\.\/)?images\/([^)]+)\)/g, (_, alt, fname) => `<img src="${resolveDocsImageUrl(fname, region, availableImages)}" alt="${escapeHtml(alt)}" loading="lazy">`);
  return output;
}

function renderMarkdown(markdown, region, availableImages) {
  const source = rewriteMarkdownLinks(markdown);
  const lines = source.split(/\r?\n/);
  const html = [];
  const toc = [];
  let paragraph = [];
  let list = [];
  let inCode = false;
  let code = [];
  let table = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "), region, availableImages)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    html.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item, region, availableImages)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushTable = () => {
    if (table.length === 0) return;
    const rows = table.map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean));
    const [head, separator, ...body] = rows;
    if (!head || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      paragraph.push(...table);
      table = [];
      return;
    }
    html.push(`<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell, region, availableImages)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell, region, availableImages)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    table = [];
  };
  const flushAll = () => {
    flushTable();
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      table.push(line);
      continue;
    }
    flushTable();

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugifyHeading(text);
      if (level >= 2 && level <= 3) toc.push({ id, text: plainText(text), level });
      html.push(`<h${level} id="${id}">${inlineMarkdown(text, region, availableImages)}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }

    const orderedItem = line.match(/^\s*\d+\.\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      list.push(orderedItem[1]);
      continue;
    }

    paragraph.push(line.trim());
  }
  flushAll();

  return { html: html.join("\n"), toc };
}

function routeTitle(route, site) {
  return route.path === "/" ? `${site.name} | ${route.title}` : `${route.title} | ${site.titleSuffix}`;
}

function baseRoutes(region) {
  const isGlobal = region === "global";
  return [
    {
      kind: "home",
      path: "/",
      title: isGlobal ? "Cloud-hosted AI Agent companion" : "越用越懂你的云端智能伙伴",
      description: SITE[region].description,
    },
    {
      kind: "about",
      path: "/about",
      title: isGlobal ? "About LightVela" : "关于我们",
      description: SITE[region].description,
    },
    ...(isGlobal ? [] : [{
      kind: "changelog",
      path: "/changelog",
      title: "更新日志",
      description: "记录 LightVela 的产品更新、能力上线与体验改进。",
    }]),
  ];
}

export function resolveStaticRoutes(region = "cn") {
  if (!["cn", "global"].includes(region)) {
    throw new Error(`unsupported static site region: ${region}`);
  }
  const docsRoutes = DOCS[region].map((doc) => ({
    kind: "doc",
    path: `/docs/${doc.slug}`,
    title: doc.title,
    description: "",
    doc,
  }));
  return [
    ...baseRoutes(region),
    {
      kind: "docs-index",
      path: "/docs",
      title: region === "global" ? "LightVela Docs" : "LightVela 文档",
      description: region === "global"
        ? "Browse LightVela product documentation and configuration guides."
        : "浏览 LightVela 产品文档、快速开始与配置指南。",
    },
    ...docsRoutes,
  ];
}

function renderJsonLd(value) {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

function renderStaticSiteCriticalStyle() {
  return [
    "<style data-static-site-critical>",
    "body{margin:0;background:#fff;color:#171717;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;}",
    ".static-site-header{border-bottom:1px solid rgba(0,0,0,.08);background:#fff;}",
    ".static-site-header nav{box-sizing:border-box;min-height:60px;max-width:1440px;margin:0 auto;padding:0 80px;display:flex;align-items:center;gap:24px;}",
    ".static-site-header a{color:#171717;text-decoration:none;font-size:14px;}",
    ".static-site-header .brand{margin-right:auto;font-weight:700;font-size:22px;}",
    ":where(.static-site-main,.static-docs-page){max-width:960px;margin:0 auto;padding:88px 24px 64px;line-height:1.75;}",
    ":where(.static-site-main,.static-docs-page) article>header{margin-bottom:32px;}",
    ":where(.static-site-main,.static-docs-page) h1{margin:0 0 16px;font-size:48px;line-height:1.15;}",
    ":where(.static-site-main,.static-docs-page) h2{margin:32px 0 12px;font-size:24px;line-height:1.35;}",
    ":where(.static-site-main,.static-docs-page) p,.static-site-footer p{margin:0 0 12px;}",
    ".static-site-footer{border-top:1px solid rgba(0,0,0,.08);padding:24px;text-align:center;color:rgba(0,0,0,.6);font-size:13px;}",
    "@media(max-width:768px){.static-site-header nav{padding:0 24px;gap:14px;flex-wrap:wrap}.static-site-header .brand{width:100%;margin:12px 0 0}:where(.static-site-main,.static-docs-page){padding-top:48px}:where(.static-site-main,.static-docs-page) h1{font-size:36px}}",
    "</style>",
  ].join("");
}

function renderHead({ route, site, siteUrl, canonicalPath, description, indexable, jsonLd }) {
  const title = routeTitle(route, site);
  const canonical = absoluteUrl(siteUrl, canonicalPath);
  const robots = indexable ? "index,follow" : "noindex,nofollow";
  const image = absoluteUrl(siteUrl, "/lightvela-logo.jpg");
  return [
    "<meta charset=\"UTF-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta name="keywords" content="${escapeHtml(SITE_KEYWORDS)}">`,
    `<meta name="robots" content="${robots}">`,
    `<link rel="canonical" href="${canonical}">`,
    "<link rel=\"icon\" type=\"image/jpeg\" href=\"/lightvela-logo.jpg\">",
    "<meta name=\"theme-color\" content=\"#ffffff\">",
    `<meta property="og:locale" content="${site.locale}">`,
    "<meta property=\"og:type\" content=\"website\">",
    `<meta property="og:site_name" content="${escapeHtml(site.name)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:image" content="${image}">`,
    "<meta name=\"twitter:card\" content=\"summary_large_image\">",
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    "<link rel=\"preload\" as=\"font\" type=\"font/woff2\" href=\"/fonts/chuangji-hei.woff2\" crossorigin>",
    "<link href=\"https://cdn.jsdelivr.net/npm/cn-fontsource-yozai-bold/font.css\" rel=\"stylesheet\">",
    renderStaticSiteCriticalStyle(),
    ...jsonLd.map(renderJsonLd),
  ].join("");
}

function extractViteAssetTags(template) {
  const headMatch = template.match(/<head>([\s\S]*?)<\/head>/i);
  const templateHead = headMatch?.[1] ?? "";
  const tags = [];
  const assetTagPattern = /<(?:script|link)\b[^>]+(?:src|href)=["']\/assets\/[^"']+["'][^>]*(?:><\/script>|>)/gi;
  for (const match of templateHead.matchAll(assetTagPattern)) {
    tags.push(match[0]);
  }
  return tags.join("");
}

function wrapPage({ template, site, head, body }) {
  const assetTags = extractViteAssetTags(template);
  return template
    .replace(/<html[^>]*>/i, `<html lang="${site.lang}">`)
    .replace(/<head>[\s\S]*?<\/head>/i, `<head>${head}${assetTags}</head>`)
    .replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${body}</div>`);
}

function renderAppShell(template, site) {
  const assetTags = extractViteAssetTags(template);
  const head = [
    "<meta charset=\"UTF-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
    `<title>${site.name}</title>`,
    "<meta name=\"robots\" content=\"noindex,nofollow\">",
    "<link rel=\"icon\" type=\"image/jpeg\" href=\"/lightvela-logo.jpg\">",
    assetTags,
  ].join("");
  const body = "<div class=\"flex min-h-dvh items-center justify-center bg-white px-4 text-sm text-[var(--text-secondary)]\">正在恢复会话...</div>";
  return template
    .replace(/<html[^>]*>/i, `<html lang="${site.lang}">`)
    .replace(/<head>[\s\S]*?<\/head>/i, `<head>${head}</head>`)
    .replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${body}</div>`);
}

function renderSiteNav(region) {
  const items = [
    ["/", region === "global" ? "Overview" : "概览"],
    ...(region === "global" ? [] : [["/changelog", "更新日志"]]),
    ["/docs/overview", region === "global" ? "Docs" : "产品文档"],
    ["/about", region === "global" ? "About" : "关于我们"],
  ];
  return `<header class="static-site-header"><nav aria-label="${region === "global" ? "Primary navigation" : "主导航"}"><a href="/" class="brand">LightVela</a>${items.map(([href, label]) => `<a href="${href}">${label}</a>`).join("")}</nav></header>`;
}

function renderFooter(region) {
  return `<footer class="static-site-footer"><p>${region === "global" ? "Copyright" : "版权所有"} © 2026 LightVela</p></footer>`;
}

function renderHome(region) {
  return [
    renderSiteNav(region),
    "<main class=\"static-site-main\">",
    "<article>",
    `<header><h1>${region === "global" ? "LightVela" : "LightVela"}</h1><p>${escapeHtml(SITE[region].description)}</p></header>`,
    `<section><h2>${region === "global" ? "What it does" : "能帮我做什么"}</h2><p>${region === "global" ? "Host a dedicated Hermes Agent in the cloud, connect models, channels, skills, and memory, then keep it online around the clock." : "在云端托管专属 Hermes Agent，连接模型、通道、技能与记忆，让它 7×24 小时在线。"}</p></section>`,
    `<section><h2>${region === "global" ? "Where to use it" : "在哪使用"}</h2><p>${region === "global" ? "Use LightVela from web pages and messaging channels." : "在网页、微信、QQ、飞书等入口使用 LightVela。"}</p></section>`,
    "</article>",
    "</main>",
    renderFooter(region),
  ].join("");
}

function renderAbout(region) {
  return [
    renderSiteNav(region),
    "<main class=\"static-site-main\">",
    "<article>",
    `<header><h1>${region === "global" ? "About LightVela" : "关于 LightVela"}</h1><p>${region === "global" ? "Every digital soul deserves to be gently lit." : "每一个数字灵魂，值得被温柔点亮。"}</p></header>`,
    `<section><h2>${region === "global" ? "Our story" : "我们的故事"}</h2><p>${region === "global" ? "LightVela brings the cloud Agent experience to more people through a managed, approachable product." : "LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端，降低配置门槛，让更多人持续、稳定、无门槛地使用 AI 服务。"}</p></section>`,
    `<section><h2>${region === "global" ? "Promise" : "承诺"}</h2><p>${region === "global" ? "Your Agent is always ready in the cloud, and your conversations belong to you." : "我们让 AI Agent 在云端为你待命，随时召之即来；你的每一次对话，都只属于你自己。"}</p></section>`,
    "</article>",
    "</main>",
    renderFooter(region),
  ].join("");
}

function renderChangelog(region) {
  return [
    renderSiteNav(region),
    "<main class=\"static-site-main\">",
    "<article>",
    "<header><h1>更新日志</h1><p>记录每一个版本的成长，持续迭代，只为给你更好的体验。</p></header>",
    "<section><h2>2026 年 6 月</h2><ul><li>LightVela 支持云存储</li><li>LightVela 支持成就模块</li><li>LightVela 支持企业微信通道</li></ul></section>",
    "<section><h2>2026 年 5 月</h2><ul><li>LightVela 支持网页内对话</li><li>LightVela 支持查看 Hermes Agent 记忆</li><li>LightVela 支持设置自动任务</li><li>Soul 人设能力上线</li></ul></section>",
    "<section><h2>2026 年 4 月</h2><p>LightVela 内测上线。</p></section>",
    "</article>",
    "</main>",
    renderFooter(region),
  ].join("");
}

function renderDocsTree(region, currentSlug) {
  const docs = DOCS[region];
  const groups = new Map();
  for (const doc of docs) {
    const group = groups.get(doc.group) ?? [];
    group.push(doc);
    groups.set(doc.group, group);
  }
  return `<aside aria-label="${region === "global" ? "Docs navigation" : "文档导航"}" class="static-docs-sidebar">${[...groups.entries()].map(([group, items]) => `<section><h2>${escapeHtml(group)}</h2><ul>${items.map((item) => `<li><a href="/docs/${item.slug}"${item.slug === currentSlug ? " aria-current=\"page\"" : ""}>${escapeHtml(item.title)}</a></li>`).join("")}</ul></section>`).join("")}</aside>`;
}

function renderBreadcrumb(region, doc) {
  const docsLabel = region === "global" ? "Docs" : "文档";
  return `<nav aria-label="breadcrumb" class="static-breadcrumb"><a href="/docs/overview">${docsLabel}</a><span>›</span><span>${escapeHtml(doc.group)}</span><span>›</span><span>${escapeHtml(doc.title)}</span></nav>`;
}

function renderToc(region, toc) {
  return `<nav aria-label="${region === "global" ? "Table of contents" : "本文目录"}" class="static-docs-toc">${toc.length === 0 ? "" : `<ol>${toc.map((item) => `<li class="level-${item.level}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join("")}</ol>`}</nav>`;
}

function renderDocsIndex(region) {
  return [
    renderSiteNav(region),
    "<main class=\"static-docs-page\">",
    renderDocsTree(region, "overview"),
    `<article><header><h1>${region === "global" ? "LightVela Docs" : "LightVela 文档"}</h1><p>${region === "global" ? "Browse product documentation and configuration guides." : "浏览产品文档、快速开始与配置指南。"}</p></header><p><a href="/docs/overview">${region === "global" ? "Start with overview" : "从概览开始"}</a></p></article>`,
    "</main>",
    renderFooter(region),
  ].join("");
}

function renderDocPage({ region, doc, markdown, availableImages }) {
  const rendered = renderMarkdown(markdown, region, availableImages);
  return {
    body: [
      renderSiteNav(region),
      "<main class=\"static-docs-page\">",
      renderDocsTree(region, doc.slug),
      "<article>",
      renderBreadcrumb(region, doc),
      rendered.html,
      "</article>",
      renderToc(region, rendered.toc),
      "</main>",
      renderFooter(region),
    ].join(""),
    toc: rendered.toc,
  };
}

function jsonLdForRoute({ route, region, siteUrl, canonicalPath, description }) {
  const site = SITE[region];
  const url = absoluteUrl(siteUrl, canonicalPath);
  if (route.kind === "doc") {
    const doc = route.doc;
    return [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: doc.title,
        description,
        mainEntityOfPage: url,
        inLanguage: site.lang,
        publisher: { "@type": "Organization", name: site.name },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: region === "global" ? "Docs" : "文档", item: absoluteUrl(siteUrl, "/docs/overview") },
          { "@type": "ListItem", position: 2, name: doc.group },
          { "@type": "ListItem", position: 3, name: doc.title, item: url },
        ],
      },
    ];
  }
  if (route.kind === "docs-index") {
    return [{
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: route.title,
      description,
      url,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: DOCS[region].map((doc, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: doc.title,
          url: absoluteUrl(siteUrl, `/docs/${doc.slug}`),
        })),
      },
    }];
  }
  if (route.kind === "changelog") {
    return [{ "@context": "https://schema.org", "@type": "CollectionPage", name: route.title, description, url }];
  }
  return [
    { "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: absoluteUrl(siteUrl, "/") },
    { "@context": "https://schema.org", "@type": "Organization", name: site.name, url: absoluteUrl(siteUrl, "/") },
  ];
}

function rewriteStaticRenderAssetUrls({ html, frontendRoot, distDir }) {
  return html.replace(/\/src\/[^"'()\s>]+\.[a-z0-9]+/gi, (assetUrl) => {
    const ext = extname(assetUrl).toLowerCase();
    if (!STATIC_RENDER_ASSET_EXTENSIONS.has(ext)) return assetUrl;

    const relativeSource = assetUrl.replace(/^\/+/, "");
    const sourcePath = join(frontendRoot, relativeSource);
    if (!existsSync(sourcePath)) return assetUrl;

    const targetRelative = join("assets", "static-render", relativeSource.replace(/^src[\\/]/, ""));
    const targetPath = join(distDir, targetRelative);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    return `/${targetRelative.split(sep).join("/")}`;
  });
}

async function createReactStaticRenderer({ frontendRoot, distDir, region }) {
  const entry = join(frontendRoot, "src", "static", "render-static-route.tsx");
  if (!existsSync(entry)) return null;

  const { createServer } = await import("vite");
  const configPath = join(frontendRoot, "vite.config.ts");
  const server = await createServer({
    root: frontendRoot,
    mode: region,
    configFile: existsSync(configPath) ? configPath : false,
    logLevel: "error",
    appType: "custom",
    optimizeDeps: { entries: [], noDiscovery: true },
    server: { middlewareMode: true },
  });
  const module = await server.ssrLoadModule("/src/static/render-static-route.tsx");
  if (typeof module.renderStaticRoute !== "function") {
    await server.close();
    throw new Error(`static route renderer must export renderStaticRoute(): ${entry}`);
  }
  return {
    render: (input) => module.renderStaticRoute(input),
    distDir,
    close: () => server.close(),
  };
}

async function renderRoute({ template, route, region, siteUrl, indexable, frontendRoot, availableImages, staticRenderer }) {
  const site = SITE[region];
  let body = "";
  let description = route.description || site.description;
  let canonicalPath = route.path;

  if (route.kind === "home") {
    body = staticRenderer
      ? await staticRenderer.render({ route, region, siteUrl })
      : "";
    if (body) body = rewriteStaticRenderAssetUrls({ html: body, frontendRoot, distDir: staticRenderer.distDir });
    if (!body) body = renderHome(region);
  }
  if (route.kind === "about") body = renderAbout(region);
  if (route.kind === "changelog") body = renderChangelog(region);
  if (route.kind === "docs-index") {
    body = renderDocsIndex(region);
    canonicalPath = "/docs/overview";
  }
  if (route.kind === "doc") {
    const markdown = readDocMarkdown(frontendRoot, region, route.doc);
    if (!markdown) {
      throw new Error(`missing markdown for ${region} doc ${route.doc.slug}: ${route.doc.file}`);
    }
    const rendered = renderDocPage({ region, doc: route.doc, markdown, availableImages });
    body = rendered.body;
    description = truncateDescription(markdown, route.description || site.description);
  }

  const jsonLd = jsonLdForRoute({ route, region, siteUrl, canonicalPath, description });
  const head = renderHead({ route, site, siteUrl, canonicalPath, description, indexable, jsonLd });
  return wrapPage({ template, site, head, body });
}

function writeRouteHtml({ distDir, route, html }) {
  const target = outputPathForRoute(distDir, route.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
}

function writeSitemap({ distDir, routes, region, siteUrl }) {
  const urls = routes
    .filter((route) => route.kind !== "docs-index")
    .map((route) => route.path)
    .sort((a, b) => a.localeCompare(b));
  if (routes.some((route) => route.kind === "docs-index")) {
    urls.push("/docs/overview");
  }
  const uniqueUrls = [...new Set(urls)];
  writeFileSync(join(distDir, "sitemap.xml"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
    ...uniqueUrls.map((path) => `  <url><loc>${absoluteUrl(siteUrl, path)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n"));
}

function writeRobots({ distDir, siteUrl, indexable }) {
  writeFileSync(join(distDir, "robots.txt"), indexable
    ? `User-agent: *\nAllow: /\nSitemap: ${absoluteUrl(siteUrl, "/sitemap.xml")}\n`
    : "User-agent: *\nDisallow: /\n");
}

function writeEdgeOneConfig(distDir) {
  writeFileSync(join(distDir, "edgeone.json"), `${JSON.stringify({
    rewrites: SPA_REWRITES.map((source) => ({ source, destination: "/app.html" })),
  }, null, 2)}\n`);
}

function writeCloudflareRedirects(distDir) {
  const redirects = SPA_REWRITES
    .filter((source) => source.endsWith("/*"))
    .map((source) => `${source} ${source.replace(/\/\*$/, "")}/ 200`);
  writeFileSync(join(distDir, "_redirects"), `${redirects.join("\n")}\n`);
}

function writeAppShellFiles({ distDir, appHtml }) {
  writeFileSync(join(distDir, "app.html"), appHtml);
  const appShellPaths = [...new Set(SPA_REWRITES.map(appShellPathFromRewrite).filter(Boolean))];
  for (const path of appShellPaths) {
    const target = outputPathForRoute(distDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, appHtml);
  }
}

function resolveIndexable(env, siteUrl) {
  if (env.STATIC_SITE_INDEXABLE === "1" || env.STATIC_SITE_INDEXABLE === "true") return true;
  if (env.STATIC_SITE_INDEXABLE === "0" || env.STATIC_SITE_INDEXABLE === "false") return false;
  return !/(^https:\/\/|^http:\/\/)?([^/]+\.)?(preview\.lightclaw\.tech|pages\.dev|edgeone\.cool|localhost|127\.0\.0\.1)(\/|$)/i.test(siteUrl);
}

function resolveCliOptions(argv, env) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key.slice(2), "true");
    } else {
      args.set(key.slice(2), next);
      i += 1;
    }
  }
  const region = args.get("region") || env.VITE_REGION || env.FRONTEND_RELEASE_REGION || "cn";
  const distDir = resolve(args.get("dist") || env.FRONTEND_BUILD_OUTPUT_DIR || (region === "global" ? "dist-global" : "dist-cn"));
  const frontendRoot = resolve(args.get("root") || defaultFrontendRoot);
  const siteUrl = normalizeSiteUrl(args.get("site-url") || env.FRONTEND_PUBLIC_BASE_URL || env.SITE_URL || SITE[region]?.defaultUrl || SITE.cn.defaultUrl);
  return {
    frontendRoot,
    distDir,
    region,
    siteUrl,
    indexable: resolveIndexable(env, siteUrl),
  };
}

export async function buildStaticSite({ frontendRoot = defaultFrontendRoot, distDir, region = "cn", siteUrl, indexable } = {}) {
  if (!distDir) throw new Error("distDir is required");
  if (!["cn", "global"].includes(region)) throw new Error(`unsupported static site region: ${region}`);
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl || SITE[region].defaultUrl);
  const template = readExistingIndex(distDir);
  const routes = resolveStaticRoutes(region);

  writeAppShellFiles({ distDir, appHtml: renderAppShell(template, SITE[region]) });

  const availableImages = copyDocsImages(frontendRoot, distDir);
  const staticRenderer = await createReactStaticRenderer({ frontendRoot, distDir, region });
  try {
    for (const route of routes) {
      const html = await renderRoute({
        template,
        route,
        region,
        siteUrl: normalizedSiteUrl,
        indexable,
        frontendRoot,
        availableImages,
        staticRenderer,
      });
      writeRouteHtml({ distDir, route, html });
    }
  } finally {
    await staticRenderer?.close();
  }
  writeSitemap({ distDir, routes, region, siteUrl: normalizedSiteUrl });
  writeRobots({ distDir, siteUrl: normalizedSiteUrl, indexable });
  writeEdgeOneConfig(distDir);
  writeCloudflareRedirects(distDir);
  return { routes };
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  buildStaticSite(resolveCliOptions(process.argv.slice(2), process.env)).then(({ routes }) => {
    console.log(`generated static site pages: ${routes.length}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
