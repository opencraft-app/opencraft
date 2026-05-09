/**
 * 静态资源 URL 工厂
 * ──────────────────────────────────────────────────────────────
 * 所有随前端发布的静态资源统一走站点自身路径：
 *   `/xxx.png` → `/xxx.png`
 *
 * 约定：
 *   1. 入参 path 必须是以 `/` 开头的 public 根相对路径（与原来写法一致），
 *      例如 `/assets/landing/hero/hero-img-1.png`；
 *   2. 传入绝对 URL（以 http / https / data: 开头）时原样返回，便于外链图片共用该函数；
 *   3. Pages / EdgeOne 本身就是 CDN，不再额外拼接独立 COS CDN 域名。
 */
const SITE_ASSET_BASE = "";

/**
 * 把 public 根路径解析为最终可访问的 URL。
 *
 * @example
 *   assetUrl("/lightvela-logo.svg")
 *   // => /lightvela-logo.svg
 */
export const assetUrl = (path: string): string => {
  if (!path) return path;
  // 已经是绝对 URL / data URI，直接返回
  if (/^(https?:)?\/\//i.test(path) || path.startsWith("data:")) {
    return path;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_ASSET_BASE}${normalized}`;
};

/** 当前是否使用独立静态资源 CDN（保留导出，兼容既有调用方） */
export const isUsingCdn = false;

/** 独立 CDN 基址（对外只读；空字符串表示使用站点自身路径） */
export const cdnBase = SITE_ASSET_BASE;
