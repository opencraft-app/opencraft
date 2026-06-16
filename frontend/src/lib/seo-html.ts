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
import { getSeoMeta, type SeoRegion } from "./seo-data";

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

  return html.replace(/(\s*<title>)/i, (match) => `    ${tag}\n${match}`);
}

export function applySeoToHtml(html: string, requestPath: string, region: SeoRegion): string {
  const meta = getSeoMeta(normalizeSeoRequestPath(requestPath), region);
  // <title> 是文本内容，用文本转义（不转 `"`）；函数式 replacement 规避 `$` 注入。
  const titleTag = `<title>${escapeHtmlText(meta.title)}</title>`;
  const htmlWithTitle = html.replace(/<title>.*?<\/title>/i, () => titleTag);
  const htmlWithDescription = replaceOrInsertMeta(htmlWithTitle, "description", meta.description);
  return replaceOrInsertMeta(htmlWithDescription, "keywords", meta.keywords);
}
