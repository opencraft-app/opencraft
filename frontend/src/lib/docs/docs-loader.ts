/**
 * 文档内容加载与预处理。
 *
 * 用 Vite 的 `import.meta.glob` 把 `@/content/docs/**` 下所有 markdown
 * 文件以纯文本形式打包进来；同目录 `images/*` 以 Vite 资源 URL 形式打包，
 * 这样 `./images/xxx.png` 会被改写成构建产物的 `/assets/xxx.hash.png`。
 *
 * 本文件的渲染前处理函数（`rewriteImagePaths` / `rewriteMarkdownLinks` /
 * `fixBoldBoundary`）严格对齐 LightVela-Docs 原实现，保证 markdown 渲染
 * 行为和现有文档站一致。
 */

import { SLUG_TO_FILE, isEnglishLocale } from "@/config/docs-sidebar";

// ── markdown 原文 ────────────────────────────────────────────────
const markdownModules = import.meta.glob("/src/content/docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// ── docs/images 下的图片资源 URL ─────────────────────────────────
const imageUrls = import.meta.glob("/src/content/docs/images/*.{png,jpg,jpeg,webp,gif,svg,avif}", {
  eager: true,
  import: "default",
}) as Record<string, string>;

/** 根据 slug 拿到对应 markdown 的原始文本，找不到返回 null。 */
export function getDocBySlug(slug: string, locale?: string): string | null {
  const filePath = SLUG_TO_FILE[slug];
  if (!filePath) return null;
  const key = `/src/content/docs/${filePath}`;
  const localizedKey = `/src/content/docs/en/${filePath}`;
  if (isEnglishLocale(locale) && markdownModules[localizedKey]) {
    return markdownModules[localizedKey] ?? null;
  }
  return markdownModules[key] ?? null;
}

/**
 * 把 markdown 里的本地图片路径改写为 Vite 构建后的 URL。
 * 识别 `./images/xxx`、`../images/xxx`、`images/xxx` 三种写法。
 * 英文环境下若存在同名 `-en` 图片，则只替换英文版图片，中文版仍使用原图。
 */
export function rewriteImagePaths(md: string, locale?: string): string {
  return md.replace(
    /!\[([^\]]*)\]\((?:\.\/|\.\.\/)?images\/([^)]+)\)/g,
    (match, alt: string, fname: string) => {
      const key = `/src/content/docs/images/${fname}`;
      const localizedName = locale?.startsWith("en")
        ? fname.replace(/(\.[^.]+)$/, "-en$1")
        : fname;
      const localizedKey = `/src/content/docs/images/${localizedName}`;
      const url = imageUrls[localizedKey] ?? imageUrls[key];
      if (!url) return match; // 找不到的保留原样，方便排查
      return `![${alt}](${url})`;
    },
  );
}

/**
 * 修复 CommonMark 在「加粗紧贴中文全角标点」时不识别边界的问题。
 *
 * 典型示例：`**「登录」**` 在 react-markdown (CommonMark) 里不会被识别为加粗，
 * 因为 `**` 两侧是全角字符，属于"非 flanking delimiter"。
 *
 * 解决办法：把这类 `**...**` 直接替换成 HTML `<strong>...</strong>`，
 * 再配合 rehype-raw 让 HTML 直通。
 *
 * 规则：成对替换，只处理一行之内的 `**X**`，且 X 中不含换行或另一个 `**`。
 */
export function fixBoldBoundary(md: string): string {
  const lines = md.split("\n");
  let inCodeBlock = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;

      // 保护行内 `code`：暂存
      const codes: string[] = [];
      const protectedLine = line.replace(/`[^`]*`/g, (m) => {
        codes.push(m);
        return `\u0000${codes.length - 1}\u0000`;
      });

      // 成对匹配 **...**（中间至少 1 个字符、不含 **、不跨行）
      const replaced = protectedLine.replace(
        /\*\*([^*\n]+?)\*\*/g,
        (_, inner: string) => `<strong>${inner}</strong>`,
      );

      // 还原行内代码
      return replaced.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? "");
    })
    .join("\n");
}

/**
 * 把 markdown 里的相对链接改写为文档站内部路由。
 * - `./02-quickstart.md` → `/docs/quickstart`
 * - `./configuration/model.md` → `/docs/configuration/model`
 * - 外链 / 锚点 / mailto / tel 保持不变
 */
export function rewriteMarkdownLinks(md: string): string {
  return md.replace(/\]\(([^)]+)\)/g, (match, url: string) => {
    if (/^(https?:|mailto:|tel:|#)/i.test(url)) return match;
    if (!/\.md($|#)/.test(url)) return match;

    let u = url.replace(/^\.\//, "").replace(/^\.\.\//, "");

    let hash = "";
    const hashIdx = u.indexOf("#");
    if (hashIdx >= 0) {
      hash = u.slice(hashIdx);
      u = u.slice(0, hashIdx);
    }

    u = u.replace(/\.md$/, "");

    // 数字前缀的文件名映射到 slug
    const map: Record<string, string> = {
      "01-overview": "overview",
      "02-quickstart": "quickstart",
      "03-account": "account",
      "04-core-concepts": "core-concepts",
      "05-configuration": "configuration",
      "07-faq": "faq",
    };
    if (map[u]) u = map[u] ?? u;

    return `](/docs/${u}${hash})`;
  });
}
