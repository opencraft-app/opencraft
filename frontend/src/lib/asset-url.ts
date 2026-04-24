/**
 * 静态资源 URL 工厂
 * ──────────────────────────────────────────────────────────────
 * 所有环境（开发 / 生产）统一走 CDN：
 *   `/xxx.png` → `${CDN_BASE}/xxx.png`
 *
 * 约定：
 *   1. 入参 path 必须是以 `/` 开头的 public 根相对路径（与原来写法一致），
 *      例如 `/assets/landing/hero/hero-img-1.png`；
 *   2. 传入绝对 URL（以 http / https / data: 开头）时原样返回，便于外链图片共用该函数；
 *   3. 如需切换 CDN 基址，直接修改下方 `CDN_BASE` 常量即可，不再依赖环境变量。
 */

// ⚠️ CDN 基址：如需更换，改这一行即可（不带尾斜杠）
const CDN_BASE = "https://lightvelacdn-1388575217.cos.ap-shanghai.myqcloud.com";

/**
 * 把 public 根路径解析为最终可访问的 URL。
 *
 * @example
 *   assetUrl("/lightvela-logo.svg")
 *   // => https://lightvelacdn-1388575217.cos.ap-shanghai.myqcloud.com/lightvela-logo.svg
 */
export const assetUrl = (path: string): string => {
  if (!path) return path;
  // 已经是绝对 URL / data URI，直接返回
  if (/^(https?:)?\/\//i.test(path) || path.startsWith("data:")) {
    return path;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${CDN_BASE}${normalized}`;
};

/** 当前是否使用 CDN（保留导出，兼容既有调用方；现恒为 true） */
export const isUsingCdn = true;

/** CDN 基址（对外只读） */
export const cdnBase = CDN_BASE;
