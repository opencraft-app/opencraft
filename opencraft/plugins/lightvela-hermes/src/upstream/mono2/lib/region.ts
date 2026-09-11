// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  type CanonicalPublicUrlLang,
  type PublicSiteLocaleCode,
  PUBLIC_URL_LANGS,
  PUBLIC_URL_LANG_TO_LOCALE,
  matchPublicLangPrefix,
  publicUrlLangForLocale,
  shouldLocalizePublicPath,
} from "./public-site-routing";

/**
 * 站点区域常量
 * ──────────────────────────────────────────────────────────────
 * 通过 NEXT_PUBLIC_REGION / VITE_REGION 兼容环境变量区分国内 / 国际站点：
 *   - `cn`     ：国内站（lightvela.com，默认）
 *   - `global` ：国际站（lightvela.ai）
 *
 * 域名真源见 `@next-site/seo` 的 siteUrl() 与 `@/lib/seo-data` 的 SITE_BY_REGION，
 * 事实口径见 `wiki/product-state/geo-fact-table.md`。
 *
 * 使用场景：
 *   1. 条件渲染（编译期常量在构建时会被折叠）：
 *      ```tsx
 *      {isCN && <WechatLogin />}
 *      {isGlobal && <GoogleLogin />}
 *      ```
 *   2. 接口 / 支付 / 客服渠道等差异化配置的入口。
 *
 * 切换方式：
 *   pnpm dev:cn          / pnpm build:cn          → REGION=cn
 *   pnpm dev:global      / pnpm build:global      → REGION=global
 */

export type Region = "cn" | "global";

const envRegion = (() => {
  if (typeof process !== "undefined") {
    const value = process.env.NEXT_PUBLIC_REGION;
    if (value === "cn" || value === "global") return value;
  }
  return import.meta.env?.VITE_REGION as Region | undefined;
})();

/**
 * 当前站点区域。
 * 默认 `cn`，保持国内站零破坏；国际站构建时会被环境变量覆盖为 `global`。
 */
export const REGION: Region = envRegion ?? (globalThis.localStorage?.getItem("vela.lightvela.region.v1") === "intl" ? "global" : "cn");

/** 是否国内站 */
export const isCN: boolean = REGION === "cn";

/** 是否国际站 */
export const isGlobal: boolean = REGION === "global";

/**
 * 默认语言（编译期常量）。
 * 国内站默认中文，国际站默认英文；运行时仍可通过 i18n 动态切换。
 */
export const DEFAULT_LOCALE: "zh-CN" | "en-US" = isGlobal ? "en-US" : "zh-CN";

/**
 * 国际站 URL 语言前缀
 * ──────────────────────────────────────────────────────────────
 * 用于 SEO：让搜索引擎能区分中英文两套静态产物。
 *
 * 仅作用于「公开可索引」路径：landing / docs / about / privacy 等
 * 营销与法律页面。登录后的应用路由（/agents、/auth、/dashboard 等）
 * 不加前缀，避免 OAuth redirect_uri 白名单需要变更。
 *
 * 国内站（isGlobal=false）这些函数全是 identity，不影响行为。
 */

/**
 * 从浏览器路径中读取语言（仅国际站；国内站固定返回 null）。
 * - 不在白名单的路径或没有前缀都返回 null（调用方应回退到 localStorage / DEFAULT_LOCALE）
 *
 * 返回类型为注册表的 `PublicSiteLocaleCode`，新增语种自动覆盖。
 */
export const readLocaleFromPath = (pathname: string): PublicSiteLocaleCode | null => {
  if (!isGlobal) return null;
  const m = matchPublicLangPrefix(pathname);
  if (!m) return null;
  return PUBLIC_URL_LANG_TO_LOCALE[m.lang] ?? null;
};

/**
 * 国际站「locale → SEO URL 前缀」映射。
 *
 * ⚠️ 刻意使用 `Record` 全量查表，而非三元链或 `startsWith('zh')` 猜测。
 * 原因：三元链带 fallback 时，新增语种若漏配**不会编译报错**，只会静默
 * 回退成英文或简体，用户侧表现为「切了语言但 URL 没变」。改为 `Record`
 * 后，注册表新增语种而此处未补条目时 `tsc` 直接失败。
 *
 * 既有语义保持不变：
 *   - 简体中文（`zh-CN` / `zh-SG`）统一使用 SEO 别名 `zh-sg`
 *   - 繁体中文使用独立前缀 `zh-hant`
 */
const INTL_SEO_URL_LANG_BY_LOCALE: Record<PublicSiteLocaleCode, CanonicalPublicUrlLang> = {
  "en-US": PUBLIC_URL_LANGS.EN_US,
  /* 国际站简体统一走 zh-sg 别名，保持既有 SEO 产物路径不变。 */
  "zh-CN": PUBLIC_URL_LANGS.ZH_SG,
  "zh-SG": PUBLIC_URL_LANGS.ZH_SG,
  "zh-Hant": PUBLIC_URL_LANGS.ZH_HANT,
  "id-ID": PUBLIC_URL_LANGS.ID_ID,
  es: PUBLIC_URL_LANGS.ES,
  "ja-JP": PUBLIC_URL_LANGS.JA_JP,
  "ko-KR": PUBLIC_URL_LANGS.KO_KR,
};

/**
 * 把绝对路径变成带语言前缀的版本（仅在国际站 + 该路径在白名单内时生效）。
 * - 国内站：identity
 * - 国际站、不需要本地化的路径（/agents、/auth 等）：identity
 * - 国际站、需要本地化的路径：加前缀；如已存在前缀则替换
 *
 * @param path 绝对路径，例如 "/docs/configuration/model"
 * @param locale 目标 i18n locale；不传则使用当前 i18n.language（运行时调用方负责传入）
 */
export const localizedPath = (path: string, locale: PublicSiteLocaleCode): string => {
  if (!isGlobal) return path;
  if (!path.startsWith("/")) return path; // 防御：相对路径 / 外链不处理

  // 已有语言前缀 → 剥掉后再决定是否本地化
  const existing = matchPublicLangPrefix(path);
  const bare = existing ? existing.rest : path;

  if (!shouldLocalizePublicPath(bare)) return bare; // 这个路径段不需要本地化（如 /agents、/auth）

  if (locale === DEFAULT_LOCALE) return bare;

  const lang = isGlobal ? INTL_SEO_URL_LANG_BY_LOCALE[locale] : publicUrlLangForLocale(locale);
  // 根路径特殊处理：/{lang}/  ←  /
  if (bare === "/") return `/${lang}/`;
  return `/${lang}${bare}`;
};

/**
 * 切换当前路径中的语言段（不改变非语言部分）。
 * 用于「语言切换器」点击时，保持当前页面 + 切换语言。
 *
 * - 国内站：identity（国内站不开多语言）
 * - 国际站：根据路径是否在本地化白名单决定加 / 改前缀；不在白名单则原样返回
 */
export const switchLocaleInPath = (
  pathname: string,
  newLocale: PublicSiteLocaleCode,
): string => localizedPath(pathname, newLocale);

/**
 * 判断给定 unprefixed 路径在国际站当前 locale 下是否需要补前缀重定向。
 *
 * 规则（仅国际站生效）：
 *   - 已带 `/en-us`、`/zh-cn`、`/zh-sg` 或旧 `/en`、`/zh` 前缀
 *     → 不重定向
 *   - 不在白名单（`/agents`、`/auth`…）→ 不重定向
 *   - 根路径 `/`                          → **不**重定向（首页保持裸 URL，
 *      与 Tencent Cloud `cloud.tencent.com/` 行为一致；多语言只对子路径生效）
 *   - 其他白名单子路径（如 `/docs/...`、`/about`、`/privacy-policy`）
 *     → 返回需要跳转到的目标路径
 *
 * 返回 null 表示「保持原 URL，不重定向」。
 *
 * 用于 RootLayout 的 mount-时 / 路由变化时一次性补前缀。
 */
export const langPrefixRedirectTarget = (
  pathname: string,
  locale: "zh-CN" | "en-US",
): string | null => {
  if (!isGlobal) return null;
  if (matchPublicLangPrefix(pathname)) return null; // 已带前缀
  if (pathname === "/") return null; // 根路径例外
  if (!shouldLocalizePublicPath(pathname)) return null; // 非 SEO 路径
  return localizedPath(pathname, locale);
};
