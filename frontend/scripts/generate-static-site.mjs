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
    /**
     * `lang` / `locale` / `description` 在国际站需要按运行 locale 切换，
     * 见 `siteMetaFor(region, locale)`。这里默认值留作回退（指标性元数据）。
     */
    lang: "en-US",
    locale: "en_US",
    name: "LightVela",
    defaultUrl: "https://lightvela.ai",
    titleSuffix: "LightVela · Your Personal Cloud AI Agent",
    description: "LightVela is a cloud Agent hosting product from the Tencent Lighthouse team. It is designed to let everyone own an AI companion that truly belongs to them—not a tool that asks you to introduce yourself every time, but a long-term presence that knows you, remembers you, and understands you better over time.",
  },
};

/**
 * 关键词列表（仅 SEO 用，不进可见 UI）。
 * 与 SITE.{region}.description 同一来源——文案变更需同时更新两处。
 */
const SITE_KEYWORDS = {
  cn: "LightVela, LightVela Agent, 云端 Agent, 个人 Agent, AI 伙伴, 腾讯轻量云, Agent 托管, 长期记忆, 个性化 AI, Hermes Agent, OpenClaw, 智能助手, AI 助手, 自动任务, 多渠道接入, QQ 机器人, 微信 Agent, 企业微信 Agent, 飞书 Agent, AI 陪伴, 个人智能体",
  global: "LightVela, LightVela Agent, cloud AI agent, personal AI agent, AI companion, Tencent Cloud, agent hosting, long-term memory, personalized AI, Hermes Agent, OpenClaw, AI assistant, automations, multi-channel, WeChat agent, Telegram bot, WhatsApp bot, Discord bot, personal agent",
};

/**
 * 国际站每个 locale 各自的本地化元信息（仅 lang / locale 标签）。
 * description 不在这里维护，避免与 SITE.{region}.description 不同步——
 * 国际站 zh 文案直接复用 SITE.cn.description；en 用 SITE.global.description。
 *
 * 拆出来是为了让 renderHead / og:locale / <html lang> 能精确匹配 locale。
 */
const GLOBAL_SITE_META_BY_LOCALE = {
  "en-US": {
    lang: "en-US",
    locale: "en_US",
    description: SITE.global.description,
  },
  "zh-CN": {
    lang: "zh-CN",
    locale: "zh_CN",
    description: SITE.cn.description,
  },
};

/** 返回当前 region+locale 应使用的站点元信息 */
const siteMetaFor = (region, locale) => {
  if (region === "global") {
    const overlay = GLOBAL_SITE_META_BY_LOCALE[locale] ?? GLOBAL_SITE_META_BY_LOCALE["en-US"];
    return { ...SITE.global, ...overlay };
  }
  return SITE.cn;
};

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
  /**
   * 国际站 docs 列表：每条 title / group 是 { en-US, zh-CN } 双语对象，
   * 与运行时 `src/config/docs-sidebar.ts::GLOBAL_SIDEBAR` 的 title/titleEn
   * 保持一致。中文翻译来自该文件，便于一处修改、两处同步。
   *
   * 注意：file 仍是物理文件名（en/zh 用同名）。markdown 内容按 locale
   * 在 readDocMarkdown 内分流到 docs/en 或 docs/global。
   */
  global: [
    { slug: "overview", title: { "en-US": "What is LightVela", "zh-CN": "LightVela 是什么" }, file: "01-overview.md", group: { "en-US": "Getting Started", "zh-CN": "开始使用" } },
    { slug: "quickstart", title: { "en-US": "Quickstart", "zh-CN": "快速开始" }, file: "02-quickstart.md", group: { "en-US": "Getting Started", "zh-CN": "开始使用" } },
    { slug: "core-concepts", title: { "en-US": "Core Concepts", "zh-CN": "核心概念" }, file: "04-core-concepts.md", group: { "en-US": "Getting Started", "zh-CN": "开始使用" } },
    { slug: "configuration", title: { "en-US": "Configuration Overview", "zh-CN": "配置总览" }, file: "05-configuration.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/model", title: { "en-US": "Configure Models", "zh-CN": "配置模型" }, file: "configuration/model.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    /* 通道名（WeChat / Telegram 等）属于专有名词，中英文可一致；保留对象形式以便未来差异化 */
    { slug: "configuration/channel-wechat", title: { "en-US": "WeChat", "zh-CN": "WeChat" }, file: "configuration/channel-wechat.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/channel-telegram", title: { "en-US": "Telegram", "zh-CN": "Telegram" }, file: "configuration/channel-telegram.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/channel-whatsapp", title: { "en-US": "WhatsApp", "zh-CN": "WhatsApp" }, file: "configuration/channel-whatsapp.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/channel-discord", title: { "en-US": "Discord", "zh-CN": "Discord" }, file: "configuration/channel-discord.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/channel-qq", title: { "en-US": "QQ", "zh-CN": "QQ" }, file: "configuration/channel-qq.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/channel-wecom", title: { "en-US": "WeCom", "zh-CN": "企业微信" }, file: "configuration/channel-wecom.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/channel-feishu", title: { "en-US": "Lark", "zh-CN": "飞书" }, file: "configuration/channel-feishu.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/skill", title: { "en-US": "Configure Skills", "zh-CN": "配置技能" }, file: "configuration/skill.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/automation", title: { "en-US": "Automations", "zh-CN": "自动任务" }, file: "configuration/automation.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "configuration/agent-chat", title: { "en-US": "Chat", "zh-CN": "对话" }, file: "configuration/agent-chat.md", group: { "en-US": "Configuration Guide", "zh-CN": "配置指南" } },
    { slug: "faq", title: { "en-US": "FAQ", "zh-CN": "常见问题 FAQ" }, file: "07-faq.md", group: { "en-US": "Reference", "zh-CN": "参考" } },
    { slug: "faq/using-lightvela-safely", title: { "en-US": "Using LightVela Safely", "zh-CN": "安全使用 LightVela" }, file: "faq/using-lightvela-safely.md", group: { "en-US": "Reference", "zh-CN": "参考" } },
  ],
};

/**
 * 从 doc.title / doc.group（cn 是字符串，global 是 {en-US, zh-CN} 对象）按 locale 取字符串。
 * 用于 docs sidebar / breadcrumb / JSON-LD 等所有需要文本标题的地方。
 */
const docFieldFor = (field, locale) => {
  if (typeof field === "string") return field;
  if (field && typeof field === "object") {
    return field[locale] ?? field["en-US"] ?? "";
  }
  return "";
};

const LEGACY_DOCS_PRERENDER_ENV = "LEGACY_DOCS_PRERENDER";

/**
 * Next/Fumadocs is the canonical docs renderer. The legacy Vite static-site
 * pass may still be used for old landing/legal fallbacks, but it must not bake
 * a second `/docs/*` tree unless an emergency rollback explicitly opts in.
 */
const APP_SHELL_REWRITES = [
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

const DOCS_APP_SHELL_REWRITES = [
  "/docs",
  "/docs/*",
  "/en/docs",
  "/en/docs/*",
  "/zh/docs",
  "/zh/docs/*",
];

const legacyDocsPrerenderEnabled = (env = process.env) => (
  env[LEGACY_DOCS_PRERENDER_ENV] === "1" || env[LEGACY_DOCS_PRERENDER_ENV] === "true"
);

const spaRewritesFor = ({ includeDocs }) => (
  includeDocs ? APP_SHELL_REWRITES : [...APP_SHELL_REWRITES, ...DOCS_APP_SHELL_REWRITES]
);

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

/**
 * 国际站语言前缀（必须与运行时 src/lib/region.ts 的 LOCALE_TO_URL_LANG 保持一致）。
 * 国内站不开多语言，cn region 始终只输出一棵 zh-CN 树（无前缀）。
 */
const LOCALE_TO_URL_LANG = {
  "en-US": "en",
  "zh-CN": "zh",
};

/**
 * 哪些路径需要带语言前缀（必须与运行时 LOCALIZED_PATH_PREFIXES 一致）。
 * 登录后路由（/agents、/auth 等）不在静态站点产物里，本文件不需要列出。
 */
const LOCALIZED_PATH_PREFIXES = ["/docs", "/about", "/privacy-policy", "/cookie-policy", "/open-source-licenses"];

const shouldLocalizePath = (path) => {
  if (path === "/") return true;
  return LOCALIZED_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
};

/**
 * 把一个绝对路径变成「带语言前缀」的版本。
 * - region=cn：identity（国内站不做语言前缀）
 * - region=global + 路径不在白名单：identity
 * - region=global + 路径在白名单：
 *    "/" → "/{lang}/"（用 / 结尾以保证 outputPathForRoute 写到 /{lang}/index.html）
 *    其它 → "/{lang}{path}"
 */
const localizePath = (path, region, locale) => {
  if (region !== "global") return path;
  if (!path.startsWith("/")) return path;
  if (!shouldLocalizePath(path)) return path;
  const lang = LOCALE_TO_URL_LANG[locale];
  if (!lang) return path;
  if (path === "/") return `/${lang}/`;
  return `/${lang}${path}`;
};

/** 国际站需要构建的所有 locale；国内站只构建中文 */
const localesForRegion = (region) => (region === "global" ? ["en-US", "zh-CN"] : ["zh-CN"]);

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

/**
 * 根据 region + locale 决定 markdown 主目录与回退目录。
 *
 * - region=cn：固定 docs/（中文），无回退
 * - region=global + locale=en-US：docs/en（英文）；找不到就回退到 docs/global（中文，避免页面缺失）
 * - region=global + locale=zh-CN：docs/global（中文）；无回退（中文必须在 global 目录下完整）
 *
 * 与运行时 src/lib/docs/docs-loader.ts 的 getDocBySlug 行为一致。
 */
function docsRootForLocale(frontendRoot, region, locale) {
  if (region !== "global") return join(frontendRoot, "src", "content", "docs");
  if (locale === "zh-CN") return join(frontendRoot, "src", "content", "docs", "global");
  return join(frontendRoot, "src", "content", "docs", "en");
}

function fallbackDocsRootForLocale(frontendRoot, region, locale) {
  if (region === "global" && locale === "en-US") {
    return join(frontendRoot, "src", "content", "docs", "global");
  }
  return null;
}

function readDocMarkdown(frontendRoot, region, locale, doc) {
  const primary = join(docsRootForLocale(frontendRoot, region, locale), doc.file);
  if (existsSync(primary)) return readFileSync(primary, "utf8");
  const fallbackRoot = fallbackDocsRootForLocale(frontendRoot, region, locale);
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

/**
 * 根据 locale 解析文档图片路径：
 * - 仅当 locale=en-US 且存在同名 `-en` 变体时使用英文图
 * - 其它情况（包括 region=global + locale=zh-CN）使用原图
 *
 * 与运行时 `frontend/src/lib/docs/docs-loader.ts:rewriteImagePaths` 行为一致。
 */
function resolveDocsImageUrl(fname, locale, availableImages = new Set()) {
  const cleanName = fname.replace(/^\.?\//, "").replace(/^images\//, "");
  if (locale === "en-US" && !/-en\.[^.]+$/.test(cleanName)) {
    const localized = cleanName.replace(/(\.[^.]+)$/, "-en$1");
    if (availableImages.has(localized)) {
      return `/assets/docs-images/${localized}`;
    }
  }
  return `/assets/docs-images/${cleanName}`;
}

/**
 * 把 markdown 内的相对 .md 链接重写为站内绝对路径，并按 region+locale 加上语言前缀。
 * 与运行时 `frontend/src/lib/docs/docs-loader.ts:rewriteMarkdownLinks` 的行为一致：
 *  - 数字前缀文件名（01-overview.md 等）映射到 slug
 *  - 国际站会得到 /en/... 或 /zh/... 前缀（取决于 locale）；国内站保持原样
 */
function rewriteMarkdownLinks(markdown, region, locale) {
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
    const slug = map[nextUrl] ?? nextUrl;
    return `](${localizePath(`/docs/${slug}`, region, locale)}${hash})`;
  });
}

function inlineMarkdown(value, locale, availableImages) {
  let output = escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, (_, text, href) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`)
    .replace(/!\[([^\]]*)]\((?:\.\/|\.\.\/)?images\/([^)]+)\)/g, (_, alt, fname) => `<img src="${resolveDocsImageUrl(fname, locale, availableImages)}" alt="${escapeHtml(alt)}" loading="lazy">`);
  return output;
}

function renderMarkdown(markdown, region, locale, availableImages) {
  const source = rewriteMarkdownLinks(markdown, region, locale);
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
    html.push(`<p>${inlineMarkdown(paragraph.join(" "), locale, availableImages)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    html.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item, locale, availableImages)}</li>`).join("")}</ul>`);
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
    html.push(`<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell, locale, availableImages)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell, locale, availableImages)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
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
      html.push(`<h${level} id="${id}">${inlineMarkdown(text, locale, availableImages)}</h${level}>`);
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

function routeTitle(route, site, locale) {
  /* route.title 在 region=global 下是按 locale 二选一的对象，cn 下保持字符串 */
  const title = typeof route.title === "string"
    ? route.title
    : (route.title?.[locale] ?? route.title?.["en-US"] ?? "");
  return route.path === "/" ? `${site.name} | ${title}` : `${title} | ${site.titleSuffix}`;
}

function routeDescription(route, locale) {
  return typeof route.description === "string"
    ? route.description
    : (route.description?.[locale] ?? route.description?.["en-US"] ?? "");
}

/**
 * 返回 region 共享的基础路由列表。
 *
 * - region=cn：title / description 是字符串（中文）
 * - region=global：title / description 是 `{ "en-US": ..., "zh-CN": ... }`
 *   两份文案按 locale 取用，避免在 renderRoute 内堆 if/else
 */
function baseRoutes(region) {
  const isGlobal = region === "global";
  return [
    {
      kind: "home",
      path: "/",
      /* 国际站 title / description 必须按 locale 二选一（运行时 routeTitle /
         routeDescription 会按 locale 取值）。文案沿用 master 的最新升级版本：
         - cn 标题 "越用越懂你的云端智能伙伴" 不变
         - global 英文 "Your Personal Cloud AI Agent"（master c6fff129）
         - global 中文标题沿用 cn 的 "越用越懂你的云端智能伙伴" 保持品牌一致 */
      title: isGlobal
        ? { "en-US": "Your Personal Cloud AI Agent", "zh-CN": "越用越懂你的云端智能伙伴" }
        : "越用越懂你的云端智能伙伴",
      description: isGlobal
        ? {
          "en-US": GLOBAL_SITE_META_BY_LOCALE["en-US"].description,
          "zh-CN": GLOBAL_SITE_META_BY_LOCALE["zh-CN"].description,
        }
        : SITE.cn.description,
    },
    {
      kind: "about",
      path: "/about",
      /* About 页文案：cn 用 master 的 "关于我们"；global 双语，沿用品牌站点描述
         （与 home 保持一致，避免 about 单独维护两套长描述与 SITE.global 不同步）。 */
      title: isGlobal
        ? { "en-US": "About LightVela", "zh-CN": "关于我们" }
        : "关于我们",
      description: isGlobal
        ? {
          "en-US": GLOBAL_SITE_META_BY_LOCALE["en-US"].description,
          "zh-CN": GLOBAL_SITE_META_BY_LOCALE["zh-CN"].description,
        }
        : SITE.cn.description,
    },
    ...(isGlobal ? [] : [{
      kind: "changelog",
      path: "/changelog",
      title: "更新日志",
      description: "记录 LightVela 的产品更新、能力上线与体验改进。",
    }]),
  ];
}

export function resolveStaticRoutes(region = "cn", { includeDocs = legacyDocsPrerenderEnabled() } = {}) {
  if (!["cn", "global"].includes(region)) {
    throw new Error(`unsupported static site region: ${region}`);
  }
  const isGlobal = region === "global";
  const docsRoutes = includeDocs ? DOCS[region].map((doc) => {
    /* doc.title 在 DOCS.global 已是 { en-US, zh-CN } 对象；DOCS.cn 是字符串。
       这里直接透传——renderRoute / jsonLdForRoute 等下游消费方会按 locale 取值。 */
    return {
      kind: "doc",
      path: `/docs/${doc.slug}`,
      title: doc.title,
      description: "",
      doc,
    };
  }) : [];
  return [
    ...baseRoutes(region),
    ...(includeDocs ? [{
      kind: "docs-index",
      path: "/docs",
      title: isGlobal
        ? { "en-US": "LightVela Docs", "zh-CN": "LightVela 文档" }
        : "LightVela 文档",
      description: isGlobal
        ? {
          "en-US": "Browse LightVela product documentation and configuration guides.",
          "zh-CN": "浏览 LightVela 产品文档、快速开始与配置指南。",
        }
        : "浏览 LightVela 产品文档、快速开始与配置指南。",
    }] : []),
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
    ".lw-landing-root{width:100%;background:#fff;overflow-x:hidden;line-height:normal;font-family:\"PingFang SC\",\"HarmonyOS Sans SC\",-apple-system,BlinkMacSystemFont,\"Helvetica Neue\",Helvetica,\"Microsoft YaHei\",Arial,sans-serif;}",
    ".lw-landing-root *{box-sizing:border-box;}",
    ".lw-landing-root a{color:inherit;text-decoration:none;background-color:transparent;}",
    ".lw-landing-root img{max-width:100%;}",
    ".lw-landing-root .relative{position:relative;}",
    ".lw-landing-root .absolute{position:absolute;}",
    ".lw-landing-root .inset-0{inset:0;}",
    ".lw-landing-root .w-full{width:100%;}",
    ".lw-landing-root .h-full{height:100%;}",
    ".lw-landing-root .object-cover{object-fit:cover;}",
    ".lw-landing-root .pointer-events-none{pointer-events:none;}",
    ".lw-landing-root .select-none{user-select:none;}",
    ".lw-landing-root header{left:0;top:0;z-index:20;width:100%;border-bottom:1px solid transparent;background:transparent;}",
    ".lw-landing-root .lw-settings-shell{position:relative;display:flex;height:60px;align-items:center;justify-content:space-between;}",
    ".lw-landing-root header a:first-child{display:flex;flex-shrink:0;align-items:center;}",
    ".lw-landing-root header img[alt=\"LightVela\"]{display:block;height:32px;width:auto;object-fit:contain;}",
    ".lw-landing-root header nav{position:absolute;left:50%;top:50%;display:none;transform:translate(-50%,-50%);align-items:center;gap:32px;}",
    ".lw-landing-root header nav a.lw-nav-link{white-space:nowrap;font-size:14px;line-height:20px;color:rgba(0,0,0,.7);}",
    ".lw-landing-root header nav a.lw-nav-link.lw-nav-link--active{font-weight:600;color:rgba(0,0,0,.9);}",
    ".lw-landing-root header .lw-settings-shell>div:last-child{display:flex;flex-shrink:0;align-items:center;gap:12px;}",
    ".lw-landing-root [data-testid=\"landing-header-auth-loading\"]{display:flex;align-items:center;gap:12px;}",
    ".lw-landing-root [data-testid=\"landing-header-auth-loading\"] span{display:block;height:36px;border-radius:100px;}",
    ".lw-landing-root [data-testid=\"landing-header-auth-loading\"] span:first-child{width:96px;background:rgba(0,0,0,.06);}",
    ".lw-landing-root [data-testid=\"landing-header-auth-loading\"] span+span{width:64px;background:rgba(0,0,0,.04);}",
    ".lw-landing-root section>img:first-child{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;user-select:none;}",
    ".lw-landing-root section>.absolute.inset-0.flex{display:flex;flex-direction:column;align-items:center;justify-content:center;}",
    "@media(min-width:1024px){.lw-landing-root header nav{display:flex;}}",
    "@media(max-width:1023px){.lw-landing-root header nav{display:none;}}",
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

/**
 * 把 `/en/docs/overview` / `/zh/docs/...` 这类带语言前缀的路径，剥回到无前缀版本。
 * 没有合法语言前缀时返回原路径。供 hreflang / sitemap 等需要「逻辑路径」的地方使用。
 */
const stripLangPrefix = (path) => {
  const m = path.match(/^\/(en|zh)(\/|$)(.*)$/);
  if (!m) return path;
  const rest = "/" + (m[3] ?? "");
  return rest === "//" ? "/" : rest;
};

/**
 * 根据 region + 当前 locale + 路径，生成 hreflang `<link>` 标签集合。
 *
 * 仅在国际站、且路径在多语言白名单内时输出。每个标签指向对应 locale 的
 * 站内 URL（含语言前缀），并加 `x-default` 指向英文版作为默认。
 *
 * @returns string  含若干 `<link rel="alternate" hreflang="...">` 的 HTML 串，
 *                  非国际站 / 非多语言路径返回空串。
 */
function renderHreflangLinks({ siteUrl, region, canonicalPath }) {
  if (region !== "global") return "";
  /* canonicalPath 已经是带 /en 或 /zh 前缀的；先剥回逻辑路径再判断是否需要本地化 */
  const bare = stripLangPrefix(canonicalPath);
  if (!shouldLocalizePath(bare)) return "";
  const enUrl = absoluteUrl(siteUrl, localizePath(bare, "global", "en-US"));
  const zhUrl = absoluteUrl(siteUrl, localizePath(bare, "global", "zh-CN"));
  return [
    `<link rel="alternate" hreflang="en" href="${enUrl}">`,
    `<link rel="alternate" hreflang="zh" href="${zhUrl}">`,
    `<link rel="alternate" hreflang="x-default" href="${enUrl}">`,
  ].join("");
}

function renderHead({ route, site, siteUrl, canonicalPath, description, indexable, jsonLd, region, locale }) {
  const title = routeTitle(route, site, locale);
  const canonical = absoluteUrl(siteUrl, canonicalPath);
  const robots = indexable ? "index,follow" : "noindex,nofollow";
  const image = absoluteUrl(siteUrl, "/lightvela-logo.jpg");
  const keywords = SITE_KEYWORDS[region] ?? SITE_KEYWORDS.cn;
  return [
    "<meta charset=\"UTF-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta name="keywords" content="${escapeHtml(keywords)}">`,
    `<meta name="robots" content="${robots}">`,
    `<link rel="canonical" href="${canonical}">`,
    renderHreflangLinks({ siteUrl, region, canonicalPath }),
    "<link rel=\"icon\" type=\"image/png\" href=\"/lightvela-icon.png\">",
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

function hoistBodyImagePreloads(body) {
  const tags = [];
  const nextBody = body.replace(/<link\b(?=[^>]*\brel=["']preload["'])(?=[^>]*\bas=["']image["'])[^>]*\/?>/gi, (tag) => {
    tags.push(tag);
    return "";
  });
  return { body: nextBody, tags: tags.join("") };
}

function wrapPage({ template, site, head, body }) {
  const assetTags = extractViteAssetTags(template);
  const { body: bodyWithoutPreloads, tags: bodyImagePreloads } = hoistBodyImagePreloads(body);
  return template
    .replace(/<html[^>]*>/i, `<html lang="${site.lang}">`)
    .replace(/<head>[\s\S]*?<\/head>/i, `<head>${head}${bodyImagePreloads}${assetTags}</head>`)
    .replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${bodyWithoutPreloads}</div>`);
}

function renderAppShell(template, site) {
  const assetTags = extractViteAssetTags(template);
  const head = [
    "<meta charset=\"UTF-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
    `<title>${site.name}</title>`,
    "<meta name=\"robots\" content=\"noindex,nofollow\">",
    "<link rel=\"icon\" type=\"image/png\" href=\"/lightvela-icon.png\">",
    assetTags,
  ].join("");
  const body = [
    "<div class=\"flex min-h-dvh bg-white px-6 py-24\" aria-hidden=\"true\">",
    "<div class=\"mx-auto w-full max-w-[1180px]\">",
    "<div class=\"mb-8 h-9 w-44 rounded-full bg-black/[0.06]\"></div>",
    "<div class=\"grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]\">",
    "<div class=\"space-y-4\">",
    "<div class=\"h-32 rounded-lg bg-black/[0.04]\"></div>",
    "<div class=\"h-32 rounded-lg bg-black/[0.04]\"></div>",
    "</div>",
    "<div class=\"h-48 rounded-lg bg-black/[0.04]\"></div>",
    "</div>",
    "</div>",
    "</div>",
  ].join("");
  return template
    .replace(/<html[^>]*>/i, `<html lang="${site.lang}">`)
    .replace(/<head>[\s\S]*?<\/head>/i, `<head>${head}</head>`)
    .replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${body}</div>`);
}

/**
 * 是否英文渲染。`locale === "en-US"` 才英文；其它（含国内站固定的 zh-CN）走中文。
 * 提供一个名字短一点的内部 helper 让模板代码更易读。
 */
const isEn = (locale) => locale === "en-US";

function renderSiteNav(region, locale) {
  const en = isEn(locale);
  const items = [
    [localizePath("/", region, locale), en ? "Overview" : "概览"],
    /* changelog 仅国内站存在；国际站不输出该路径 */
    ...(region === "global" ? [] : [["/changelog", "更新日志"]]),
    [localizePath("/docs/overview", region, locale), en ? "Docs" : "产品文档"],
    [localizePath("/about", region, locale), en ? "About" : "关于我们"],
  ];
  return `<header class="static-site-header"><nav aria-label="${en ? "Primary navigation" : "主导航"}"><a href="${localizePath("/", region, locale)}" class="brand">LightVela</a>${items.map(([href, label]) => `<a href="${href}">${label}</a>`).join("")}</nav></header>`;
}

function renderFooter(region, locale) {
  return `<footer class="static-site-footer"><p>${isEn(locale) ? "Copyright" : "版权所有"} © 2026 LightVela</p></footer>`;
}

function renderHome(region, locale) {
  const en = isEn(locale);
  const meta = siteMetaFor(region, locale);
  return [
    renderSiteNav(region, locale),
    "<main class=\"static-site-main\">",
    "<article>",
    `<header><h1>LightVela</h1><p>${escapeHtml(meta.description)}</p></header>`,
    `<section><h2>${en ? "What it does" : "能帮我做什么"}</h2><p>${en ? "Host a dedicated Hermes Agent in the cloud, connect models, channels, skills, and memory, then keep it online around the clock." : "在云端托管专属 Hermes Agent，连接模型、通道、技能与记忆，让它 7×24 小时在线。"}</p></section>`,
    `<section><h2>${en ? "Where to use it" : "在哪使用"}</h2><p>${en ? "Use LightVela from web pages and messaging channels." : "在网页、微信、QQ、飞书等入口使用 LightVela。"}</p></section>`,
    "</article>",
    "</main>",
    renderFooter(region, locale),
  ].join("");
}

function renderAbout(region, locale) {
  const en = isEn(locale);
  return [
    renderSiteNav(region, locale),
    "<main class=\"static-site-main\">",
    "<article>",
    `<header><h1>${en ? "About LightVela" : "关于 LightVela"}</h1><p>${en ? "Every digital soul deserves to be gently lit." : "每一个数字灵魂，值得被温柔点亮。"}</p></header>`,
    `<section><h2>${en ? "Our story" : "我们的故事"}</h2><p>${en ? "LightVela brings the cloud Agent experience to more people through a managed, approachable product." : "LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端，降低配置门槛，让更多人持续、稳定、无门槛地使用 AI 服务。"}</p></section>`,
    `<section><h2>${en ? "Promise" : "承诺"}</h2><p>${en ? "Your Agent is always ready in the cloud, and your conversations belong to you." : "我们让 AI Agent 在云端为你待命，随时召之即来；你的每一次对话，都只属于你自己。"}</p></section>`,
    "</article>",
    "</main>",
    renderFooter(region, locale),
  ].join("");
}

function renderChangelog(region, locale) {
  /* 仅国内站使用，locale 始终是 zh-CN，保留原中文文案 */
  return [
    renderSiteNav(region, locale),
    "<main class=\"static-site-main\">",
    "<article>",
    "<header><h1>更新日志</h1><p>记录每一个版本的成长，持续迭代，只为给你更好的体验。</p></header>",
    "<section><h2>2026 年 6 月</h2><ul><li>LightVela 支持云存储</li><li>LightVela 支持成就模块</li><li>LightVela 支持企业微信通道</li></ul></section>",
    "<section><h2>2026 年 5 月</h2><ul><li>LightVela 支持网页内对话</li><li>LightVela 支持查看 Hermes Agent 记忆</li><li>LightVela 支持设置自动任务</li><li>Soul 人设能力上线</li></ul></section>",
    "<section><h2>2026 年 4 月</h2><p>LightVela 内测上线。</p></section>",
    "</article>",
    "</main>",
    renderFooter(region, locale),
  ].join("");
}

/**
 * docs 侧边栏：按当前 locale 从 doc.title / doc.group 取出对应语言的标题。
 *
 * 国际站：title / group 是 { en-US, zh-CN } 对象，与运行时 React 侧
 * `getLocalizedSidebar` 行为一致，保证 `/zh/docs/...` 静态产物的 sidebar
 * 也是中文，与 `<html lang="zh-CN">` 声明匹配（hreflang 质量必要条件）。
 *
 * 国内站：title / group 是字符串，docFieldFor 直接返回。
 *
 * 分组键用 group 的英文名（locale-stable）做 Map key，避免英文/中文混用时
 * Map 把同一组拆成两条；显示时再按 locale 取展示文本。
 */
function renderDocsTree(region, locale, currentSlug) {
  const docs = DOCS[region];
  const groups = new Map();
  for (const doc of docs) {
    const groupKey = docFieldFor(doc.group, "en-US") || docFieldFor(doc.group, locale);
    const entry = groups.get(groupKey) ?? { displayTitle: docFieldFor(doc.group, locale), items: [] };
    entry.items.push(doc);
    groups.set(groupKey, entry);
  }
  return `<aside aria-label="${isEn(locale) ? "Docs navigation" : "文档导航"}" class="static-docs-sidebar">${[...groups.values()].map(({ displayTitle, items }) => `<section><h2>${escapeHtml(displayTitle)}</h2><ul>${items.map((item) => `<li><a href="${localizePath("/docs/" + item.slug, region, locale)}"${item.slug === currentSlug ? " aria-current=\"page\"" : ""}>${escapeHtml(docFieldFor(item.title, locale))}</a></li>`).join("")}</ul></section>`).join("")}</aside>`;
}

function renderBreadcrumb(region, locale, doc) {
  const docsLabel = isEn(locale) ? "Docs" : "文档";
  return `<nav aria-label="breadcrumb" class="static-breadcrumb"><a href="${localizePath("/docs/overview", region, locale)}">${docsLabel}</a><span>›</span><span>${escapeHtml(docFieldFor(doc.group, locale))}</span><span>›</span><span>${escapeHtml(docFieldFor(doc.title, locale))}</span></nav>`;
}

function renderToc(region, locale, toc) {
  return `<nav aria-label="${isEn(locale) ? "Table of contents" : "本文目录"}" class="static-docs-toc">${toc.length === 0 ? "" : `<ol>${toc.map((item) => `<li class="level-${item.level}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join("")}</ol>`}</nav>`;
}

function renderDocsIndex(region, locale) {
  const en = isEn(locale);
  return [
    renderSiteNav(region, locale),
    "<main class=\"static-docs-page\">",
    renderDocsTree(region, locale, "overview"),
    `<article><header><h1>${en ? "LightVela Docs" : "LightVela 文档"}</h1><p>${en ? "Browse product documentation and configuration guides." : "浏览产品文档、快速开始与配置指南。"}</p></header><p><a href="${localizePath("/docs/overview", region, locale)}">${en ? "Start with overview" : "从概览开始"}</a></p></article>`,
    "</main>",
    renderFooter(region, locale),
  ].join("");
}

function renderDocPage({ region, locale, doc, markdown, availableImages }) {
  const rendered = renderMarkdown(markdown, region, locale, availableImages);
  return {
    body: [
      renderSiteNav(region, locale),
      "<main class=\"static-docs-page\">",
      renderDocsTree(region, locale, doc.slug),
      "<article>",
      renderBreadcrumb(region, locale, doc),
      rendered.html,
      "</article>",
      renderToc(region, locale, rendered.toc),
      "</main>",
      renderFooter(region, locale),
    ].join(""),
    toc: rendered.toc,
  };
}

function jsonLdForRoute({ route, region, locale, siteUrl, canonicalPath, description }) {
  const site = siteMetaFor(region, locale);
  /* canonicalPath 已经是带语言前缀的，直接拼绝对 URL */
  const url = absoluteUrl(siteUrl, canonicalPath);
  const docsRootUrl = absoluteUrl(siteUrl, localizePath("/docs/overview", region, locale));
  if (route.kind === "doc") {
    const doc = route.doc;
    /* doc.title / doc.group 在国际站是 { en-US, zh-CN } 双语对象，国内站是字符串。
       docFieldFor 同时处理两种形态，按当前 locale 取显示文本。 */
    const docTitle = docFieldFor(doc.title, locale);
    const docGroup = docFieldFor(doc.group, locale);
    return [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: docTitle,
        description,
        mainEntityOfPage: url,
        inLanguage: site.lang,
        publisher: { "@type": "Organization", name: site.name },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: isEn(locale) ? "Docs" : "文档", item: docsRootUrl },
          { "@type": "ListItem", position: 2, name: docGroup },
          { "@type": "ListItem", position: 3, name: docTitle, item: url },
        ],
      },
    ];
  }
  if (route.kind === "docs-index") {
    return [{
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: routeTitle(route, site, locale),
      description,
      url,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: DOCS[region].map((doc, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: docFieldFor(doc.title, locale),
          url: absoluteUrl(siteUrl, localizePath(`/docs/${doc.slug}`, region, locale)),
        })),
      },
    }];
  }
  if (route.kind === "changelog") {
    return [{ "@context": "https://schema.org", "@type": "CollectionPage", name: routeTitle(route, site, locale), description, url }];
  }
  return [
    { "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: absoluteUrl(siteUrl, localizePath("/", region, locale)) },
    { "@context": "https://schema.org", "@type": "Organization", name: site.name, url: absoluteUrl(siteUrl, localizePath("/", region, locale)) },
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

async function renderRoute({
  template,
  route,
  region,
  locale,
  siteUrl,
  indexable,
  frontendRoot,
  availableImages,
  staticRenderer,
  /**
   * 当为 true 时，渲染产物用于「裸 `/` 入口」（覆盖 vite 留下的 dist/index.html）。
   * 主要目的：让国际站 `lightvela.ai/` 也成为 hreflang 集群的合法成员，
   * canonical 指向 `/en/`（让 Google 把权重收敛到带前缀版本），但页面体验
   * 与 `/en/` 一致——访客不会经历跳转闪烁。
   */
  rootAliasOfEn = false,
} = {}) {
  const site = siteMetaFor(region, locale);
  let body = "";
  /* description 也可能是按 locale 二选一的对象 */
  const baseDescription = routeDescription(route, locale) || site.description;
  let description = baseDescription;
  /* canonicalPath 默认就是路由的逻辑路径；下面会按 locale 加语言前缀 */
  let canonicalPath = route.path;

  if (route.kind === "home") {
    body = staticRenderer
      ? await staticRenderer.render({ route, region, locale, siteUrl })
      : "";
    if (body) body = rewriteStaticRenderAssetUrls({ html: body, frontendRoot, distDir: staticRenderer.distDir });
    if (!body) body = renderHome(region, locale);
  }
  if (route.kind === "about") body = renderAbout(region, locale);
  if (route.kind === "changelog") body = renderChangelog(region, locale);
  if (route.kind === "docs-index") {
    body = renderDocsIndex(region, locale);
    canonicalPath = "/docs/overview";
  }
  if (route.kind === "doc") {
    const markdown = readDocMarkdown(frontendRoot, region, locale, route.doc);
    if (!markdown) {
      throw new Error(`missing markdown for ${region} ${locale} doc ${route.doc.slug}: ${route.doc.file}`);
    }
    const rendered = renderDocPage({ region, locale, doc: route.doc, markdown, availableImages });
    body = rendered.body;
    description = truncateDescription(markdown, baseDescription);
  }

  /* 把 canonicalPath 加上语言前缀（cn / 不在白名单的路径下 identity）。
     rootAliasOfEn 模式下：内容沿用 en-US 渲染，但 canonical 仍指向 `/en/`，
     hreflang 集群保持一致（renderHreflangLinks 内部以 canonicalPath 推断备用 URL，
     传 `/en/` 即可覆盖 `/`、`/en/`、`/zh/` 三个 URL 为同一集群）。 */
  const localizedCanonical = rootAliasOfEn
    ? localizePath(canonicalPath, region, "en-US")
    : localizePath(canonicalPath, region, locale);

  const jsonLd = jsonLdForRoute({ route, region, locale, siteUrl, canonicalPath: localizedCanonical, description });
  const head = renderHead({ route, site, siteUrl, canonicalPath: localizedCanonical, description, indexable, jsonLd, region, locale });
  return wrapPage({ template, site, head, body });
}

function writeRouteHtml({ distDir, route, region, locale, html }) {
  /* outputPath 也按语言前缀写入：/en/about/index.html、/zh/docs/overview/index.html 等 */
  const localizedRoutePath = localizePath(route.path, region, locale);
  const target = outputPathForRoute(distDir, localizedRoutePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
}

function writeSitemap({ distDir, routes, region, siteUrl }) {
  const locales = localesForRegion(region);
  /**
   * 国际站每个路由对每个 locale 各产出一条 URL；并通过 `xhtml:link` hreflang
   * 让搜索引擎知道两条 URL 是同一内容的不同语言版本。
   *
   * 国内站只有 zh-CN 一个 locale，等价于原行为（每路由一条 URL，无 hreflang）。
   */
  const baseRoutes = routes.filter((route) => route.kind !== "docs-index");
  const hasDocsIndex = routes.some((route) => route.kind === "docs-index");

  /** 收集 (path, locale) 二元组，按 path 字典序排序保证产物稳定 */
  const entries = [];
  for (const route of baseRoutes) {
    for (const locale of locales) {
      entries.push({ basePath: route.path, locale });
    }
  }
  if (hasDocsIndex) {
    for (const locale of locales) {
      entries.push({ basePath: "/docs/overview", locale });
    }
  }
  /* 去重（理论上不会重复，但 docs-index 也写 /docs/overview，与 doc kind 的 overview 重合） */
  const seen = new Set();
  const uniqueEntries = [];
  for (const entry of entries) {
    const key = `${entry.basePath}|${entry.locale}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEntries.push(entry);
  }
  uniqueEntries.sort((a, b) => {
    const pa = localizePath(a.basePath, region, a.locale);
    const pb = localizePath(b.basePath, region, b.locale);
    return pa.localeCompare(pb);
  });

  const useHreflang = region === "global";
  const xmlHeader = useHreflang
    ? "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">"
    : "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">";

  const renderUrlEntry = ({ basePath, locale }) => {
    const localizedPathStr = localizePath(basePath, region, locale);
    const loc = absoluteUrl(siteUrl, localizedPathStr);
    if (!useHreflang) return `  <url><loc>${loc}</loc></url>`;
    /* 在国际站里，每条 URL 同时声明所有 locale 的 hreflang 备用链接 + x-default */
    const alts = locales.map((alt) => {
      const altLoc = absoluteUrl(siteUrl, localizePath(basePath, region, alt));
      const lang = LOCALE_TO_URL_LANG[alt];
      return `<xhtml:link rel="alternate" hreflang="${lang}" href="${altLoc}"/>`;
    }).join("");
    const xDefault = `<xhtml:link rel="alternate" hreflang="x-default" href="${absoluteUrl(siteUrl, localizePath(basePath, region, "en-US"))}"/>`;
    return `  <url><loc>${loc}</loc>${alts}${xDefault}</url>`;
  };

  writeFileSync(join(distDir, "sitemap.xml"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    xmlHeader,
    ...uniqueEntries.map(renderUrlEntry),
    "</urlset>",
    "",
  ].join("\n"));
}

function writeRobots({ distDir, siteUrl, indexable }) {
  writeFileSync(join(distDir, "robots.txt"), indexable
    ? `User-agent: *\nAllow: /\nSitemap: ${absoluteUrl(siteUrl, "/sitemap.xml")}\n`
    : "User-agent: *\nDisallow: /\n");
}

function writeEdgeOneConfig(distDir, { includeDocs }) {
  const rewrites = spaRewritesFor({ includeDocs });
  writeFileSync(join(distDir, "edgeone.json"), `${JSON.stringify({
    rewrites: rewrites.map((source) => ({ source, destination: "/app.html" })),
  }, null, 2)}\n`);
}

function writeCloudflareRedirects(distDir, { includeDocs }) {
  const redirects = spaRewritesFor({ includeDocs })
    .filter((source) => source.endsWith("/*"))
    .map((source) => `${source} ${source.replace(/\/\*$/, "")}/ 200`);
  writeFileSync(join(distDir, "_redirects"), `${redirects.join("\n")}\n`);
}

function writeAppShellFiles({ distDir, appHtml, includeDocs }) {
  writeFileSync(join(distDir, "app.html"), appHtml);
  const appShellPaths = [...new Set(spaRewritesFor({ includeDocs }).map(appShellPathFromRewrite).filter(Boolean))];
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

export async function buildStaticSite({
  frontendRoot = defaultFrontendRoot,
  distDir,
  region = "cn",
  siteUrl,
  indexable,
  includeDocs = legacyDocsPrerenderEnabled(),
} = {}) {
  if (!distDir) throw new Error("distDir is required");
  if (!["cn", "global"].includes(region)) throw new Error(`unsupported static site region: ${region}`);
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl || SITE[region].defaultUrl);
  const template = readExistingIndex(distDir);
  const routes = resolveStaticRoutes(region, { includeDocs });

  writeAppShellFiles({ distDir, appHtml: renderAppShell(template, SITE[region]), includeDocs });

  const availableImages = includeDocs ? copyDocsImages(frontendRoot, distDir) : new Set();
  const staticRenderer = await createReactStaticRenderer({ frontendRoot, distDir, region });
  try {
    /**
     * 国际站每个 route 对每个 locale 渲染并写入一份 HTML（路径带 /en /zh 前缀）；
     * 国内站只渲染一个 locale=zh-CN，路径无前缀（与原行为一致）。
     */
    const locales = localesForRegion(region);
    for (const locale of locales) {
      for (const route of routes) {
        const html = await renderRoute({
          template,
          route,
          region,
          locale,
          siteUrl: normalizedSiteUrl,
          indexable,
          frontendRoot,
          availableImages,
          staticRenderer,
        });
        writeRouteHtml({ distDir, route, region, locale, html });
      }
    }

    /**
     * 国际站补一份「裸 `/`」首页：内容与 `/en/` 完全一致，但 canonical 指向 `/en/`，
     * 让 vite 留下的中文 dist/index.html 被覆盖，并把 `/`、`/en/`、`/zh/` 收敛到
     * 同一 hreflang 集群（避免 Google 看到三个游离的首页 URL）。
     */
    if (region === "global") {
      const homeRoute = routes.find((route) => route.kind === "home");
      if (!homeRoute) {
        throw new Error("global build expects a home route, but none was found in resolveStaticRoutes");
      }
      const aliasHtml = await renderRoute({
        template,
        route: homeRoute,
        region,
        locale: "en-US",
        siteUrl: normalizedSiteUrl,
        indexable,
        frontendRoot,
        availableImages,
        staticRenderer,
        rootAliasOfEn: true,
      });
      writeFileSync(join(distDir, "index.html"), aliasHtml);
    }
  } finally {
    await staticRenderer?.close();
  }
  writeSitemap({ distDir, routes, region, siteUrl: normalizedSiteUrl });
  writeRobots({ distDir, siteUrl: normalizedSiteUrl, indexable });
  writeEdgeOneConfig(distDir, { includeDocs });
  writeCloudflareRedirects(distDir, { includeDocs });
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
