/**
 * SEO HTML 注入工具（dev server SSR 用）。
 *
 * 该模块被 `vite.config.ts` 在 node/esbuild 上下文直接 import，因此：
 *   - 只能 import 同样 node-safe 的相对模块（如 ./seo-data）；
 *   - 不得依赖 `@/` alias 或 `import.meta.env`。
 *
 * 抽离到独立模块的好处：逻辑可被单元测试覆盖（转义 / `$` 元字符注入回归），
 * 不再内联在 vite.config 中无人守护。
 */
import {
  getFullSeoMeta,
  getSeoMeta,
  type FullSeoMeta,
  type FullSeoMetaOptions,
  type SeoRegion,
} from "./seo-data";

/**
 * 字符级转义：用函数式 replacement 一次性替换，
 * 避免 String.prototype.replace 对替换串中的 `$&` / `$1` / `$$` 做特殊解释，
 * 也避免链式 replace 把上一步产物里的 `&` 再次当作替换标记触发注入。
 */
function escapeWith(value: string, map: Record<string, string>): string {
  const pattern = new RegExp(`[${Object.keys(map).map((c) => `\\${c}`).join("")}]`, "g");
  return value.replace(pattern, (ch) => map[ch] ?? ch);
}

/** HTML 属性值转义：属性上下文必须转义 `"`。 */
export function escapeHtmlAttribute(value: string): string {
  return escapeWith(value, {
    "&": "&amp;",
    '"': "&quot;",
    "<": "&lt;",
    ">": "&gt;",
  });
}

/**
 * HTML 文本内容转义（非属性）。
 * 文本节点里的 `"` 不需要转义；强行转成 `&quot;` 会被部分爬虫原样收录进
 * <title>，污染 SEO 标题。这里只转义文本上下文真正需要的 `&` / `<` / `>`。
 */
export function escapeHtmlText(value: string): string {
  return escapeWith(value, {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  });
}

export function normalizeSeoRequestPath(requestPath: string): string {
  const pathname = requestPath.startsWith("http")
    ? new URL(requestPath).pathname
    : new URL(requestPath, "http://localhost").pathname;
  return pathname === "/index.html" ? "/" : pathname;
}

export function replaceOrInsertMeta(html: string, name: string, content: string): string {
  const tag = `<meta name="${name}" content="${escapeHtmlAttribute(content)}" />`;
  const pattern = new RegExp(`<meta\\s+name=["']${name}["'][^>]*>`, "i");

  // 用函数式 replacement，避免 content 含 `$`（如 `$1` / `$&` / `$$`）时
  // 被 String.prototype.replace 当作特殊替换模式，造成元字符注入 bug。
  if (pattern.test(html)) {
    return html.replace(pattern, () => tag);
  }

  return insertBeforeTitle(html, tag);
}

export function applySeoToHtml(html: string, requestPath: string, region: SeoRegion): string {
  const meta = getSeoMeta(normalizeSeoRequestPath(requestPath), region);
  // <title> 是文本内容，用文本转义（不转 `"`）；函数式 replacement 规避 `$` 注入。
  const titleTag = `<title>${escapeHtmlText(meta.title)}</title>`;
  const htmlWithTitle = html.replace(/<title>.*?<\/title>/i, () => titleTag);
  const htmlWithDescription = replaceOrInsertMeta(htmlWithTitle, "description", meta.description);
  return replaceOrInsertMeta(htmlWithDescription, "keywords", meta.keywords);
}

/**
 * 在 `<title>` 之前插入新 tag。
 *
 * 之前的实现用 `(\s*<title>)` 贪婪吞掉前导空白后再拼回，会导致：
 *   1) 多次插入累积出大量空行（每次拼一个 `\n`，N 次 fallback 就有 N 个空行）；
 *   2) 当 `<title>` 在 vite dev 注入 `<script>` 后被顶到 head 末尾时，前导空白
 *      序列里夹了脚本内容，整段被吞回会破坏布局。
 *
 * 这里改成"非贪婪、零宽前瞻定位 `<title>`"，仅在 `<title>` 前插入一行，
 * 保留原 head 既有缩进/换行不变。replacement 用函数式形式，规避 `$` 注入。
 */
function insertBeforeTitle(html: string, tag: string): string {
  if (/<title>/i.test(html)) {
    return html.replace(/(?=<title>)/i, () => `${tag}\n    `);
  }
  // 兜底：没有 <title>，则在 <head> 之后插
  return html.replace(/<head>/i, (m) => `${m}\n    ${tag}`);
}

/**
 * 通用 head 标签写入：先尝试按选择器匹配替换，匹配不到则在 `<title>` 之前插入。
 * 用函数式 replacement 防止 content 含 `$` 元字符被解释为替换模式（CR2 同源风险）。
 */
function upsertHeadTag(html: string, matcher: RegExp, tag: string): string {
  if (matcher.test(html)) {
    return html.replace(matcher, () => tag);
  }
  return insertBeforeTitle(html, tag);
}

function setMetaProperty(html: string, property: string, content: string): string {
  const tag = `<meta property="${property}" content="${escapeHtmlAttribute(content)}" />`;
  const matcher = new RegExp(`<meta\\s+property=["']${property}["'][^>]*>`, "i");
  return upsertHeadTag(html, matcher, tag);
}

function setMetaName(html: string, name: string, content: string): string {
  const tag = `<meta name="${name}" content="${escapeHtmlAttribute(content)}" />`;
  const matcher = new RegExp(`<meta\\s+name=["']${name}["'][^>]*>`, "i");
  return upsertHeadTag(html, matcher, tag);
}

function setLink(html: string, rel: string, href: string): string {
  const tag = `<link rel="${rel}" href="${escapeHtmlAttribute(href)}" />`;
  const matcher = new RegExp(`<link\\s+rel=["']${rel}["'][^>]*>`, "i");
  return upsertHeadTag(html, matcher, tag);
}

function setHtmlLang(html: string, lang: string): string {
  return html.replace(
    /<html\b([^>]*)>/i,
    (_match, attrs: string) => {
      const attrsWithoutLang = attrs.replace(/\s+lang=(["'])[^"']*\1/i, "");
      return `<html${attrsWithoutLang} lang="${escapeHtmlAttribute(lang)}">`;
    },
  );
}

/**
 * 完整 SEO 注入：title/description/keywords + canonical + robots + OG + Twitter + `<html lang>`。
 * 用于 dev 中间件，使开发态首屏 HTML 与 prerender 产物字段对齐。
 */
export function applyFullSeoToHtml(
  html: string,
  requestPath: string,
  region: SeoRegion,
  options: FullSeoMetaOptions = {},
): string {
  const meta: FullSeoMeta = getFullSeoMeta(normalizeSeoRequestPath(requestPath), region, options);

  let next = html;
  next = setHtmlLang(next, meta.htmlLang);

  // <title> 文本内容（不转引号）
  const titleTag = `<title>${escapeHtmlText(meta.title)}</title>`;
  if (/<title>.*?<\/title>/i.test(next)) {
    next = next.replace(/<title>.*?<\/title>/i, () => titleTag);
  } else {
    next = next.replace(/<head>/i, (m) => `${m}\n    ${titleTag}`);
  }

  // 基础 meta
  next = replaceOrInsertMeta(next, "description", meta.description);
  next = replaceOrInsertMeta(next, "keywords", meta.keywords);
  next = setMetaName(next, "robots", meta.robots);

  // canonical
  next = setLink(next, "canonical", meta.canonical);

  // Open Graph
  next = setMetaProperty(next, "og:locale", meta.ogLocale);
  next = setMetaProperty(next, "og:type", meta.ogType);
  next = setMetaProperty(next, "og:site_name", meta.ogSiteName);
  next = setMetaProperty(next, "og:title", meta.ogTitle);
  next = setMetaProperty(next, "og:description", meta.ogDescription);
  next = setMetaProperty(next, "og:url", meta.ogUrl);
  next = setMetaProperty(next, "og:image", meta.ogImage);

  // Twitter Card
  next = setMetaName(next, "twitter:card", meta.twitterCard);
  next = setMetaName(next, "twitter:title", meta.twitterTitle);
  next = setMetaName(next, "twitter:description", meta.twitterDescription);
  next = setMetaName(next, "twitter:image", meta.twitterImage);

  return next;
}
