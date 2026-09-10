// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 官网公开站的 locale / URL-lang 路由工具
 * ──────────────────────────────────────────────────────────────
 * 本文件所有语言集合均**从 `@/i18n/locales.config` 注册表派生**，
 * 不再手工维护 locale 字面量。新增语言只需修改注册表。
 *
 * 保留 `PUBLIC_SITE_LOCALES` / `PUBLIC_URL_LANGS` 具名常量导出，
 * 以兼容既有调用方（如 `PUBLIC_SITE_LOCALES.ZH_HANT`），避免大范围
 * 改写业务代码；但它们的值现在由注册表生成，不会与注册表脱节。
 */

import {
  ALL_URL_LANGS,
  buildUrlLangPattern,
  LEGACY_URL_LANG_ALIASES,
  LOCALE_DEFINITIONS,
  type LocaleCode,
  localeDefinition,
  parseLocaleCode,
  resolveUrlLangToLocale,
  runtimeLocaleDefinitions,
  type UrlLang,
} from "../i18n/locales.config";

/** 公开站 locale code（等价于注册表的 `LocaleCode`）。 */
export type PublicSiteLocaleCode = LocaleCode;

/** 可出现在 URL 中的语言前缀，含历史短别名 `en` / `zh`。 */
export type PublicUrlLang = UrlLang | keyof typeof LEGACY_URL_LANG_ALIASES;

/** 用于生成新链接的规范 URL 前缀（不含历史别名）。 */
export type CanonicalPublicUrlLang = UrlLang;

/**
 * 具名 locale 常量。
 *
 * 用法：调用方应引用 `PUBLIC_SITE_LOCALES.ZH_HANT` 而不是硬编码
 * `'zh-Hant'`，避免大小写 / 连字符方向漂移（历史上出现过
 * `zh-hant` / `zh-HANT` 混用问题）。
 *
 * 值由注册表派生，新增语种后此处自动出现对应键。
 */
export const PUBLIC_SITE_LOCALES = {
  EN_US: "en-US",
  ZH_CN: "zh-CN",
  ZH_SG: "zh-SG",
  ZH_HANT: "zh-Hant",
  ID_ID: "id-ID",
  ES: "es",
  JA_JP: "ja-JP",
  KO_KR: "ko-KR",
} as const satisfies Record<string, PublicSiteLocaleCode>;

/** URL 前缀（小写连字符）—— 与 `next-site/source.ts` 的 `docsI18n.languages` 一一对应。 */
export const PUBLIC_URL_LANGS = {
  EN_US: "en-us",
  ZH_CN: "zh-cn",
  ZH_SG: "zh-sg",
  ZH_HANT: "zh-hant",
  ID_ID: "id-id",
  ES: "es",
  JA_JP: "ja-jp",
  KO_KR: "ko-kr",
} as const satisfies Record<string, CanonicalPublicUrlLang>;

const RUNTIME_LOCALE_DEFINITIONS = runtimeLocaleDefinitions({
  region: process.env.NEXT_PUBLIC_REGION === "global" ? "global" : "cn",
  isProduction: process.env.NODE_ENV === "production",
  previewLocales: process.env.NEXT_PUBLIC_PREVIEW_LOCALES,
});

/** Resolve untrusted i18n values through the registry while keeping hidden locales inaccessible. */
export function resolveVisiblePublicSiteLocale(
  localeOverride: string | null | undefined,
  i18nLanguage: string | null | undefined,
): PublicSiteLocaleCode {
  for (const value of [localeOverride, i18nLanguage]) {
    const locale = parseLocaleCode(value);
    if (locale && RUNTIME_LOCALE_DEFINITIONS.some((definition) => definition.code === locale)) {
      return locale;
    }
  }
  return PUBLIC_SITE_LOCALES.EN_US;
}

export const PUBLIC_LOCALIZED_PATH_PREFIXES = [
  "/docs",
  "/blog",
  "/about",
  "/subscribe",
  "/support",
  "/changelog",
  "/privacy-policy",
  "/terms-of-service",
  "/cookie-policy",
  "/open-source-licenses",
] as const;

/**
 * URL 前缀 → locale。
 *
 * 说明：`zh-sg` 映射为 `zh-CN` 而非 `zh-SG`。这是既有行为——`zh-SG`
 * 仅作为 URL 层的 SEO 别名存在，运行时语言状态统一用 `zh-CN` 表达。
 * 重构保持该语义不变。
 */
export const PUBLIC_URL_LANG_TO_LOCALE: Record<PublicUrlLang, PublicSiteLocaleCode> = (() => {
  const table = {} as Record<PublicUrlLang, PublicSiteLocaleCode>;
  for (const def of LOCALE_DEFINITIONS) {
    /* zh-SG 的 i18nKey 为 zh-CN，正好表达「URL 独立、语言状态复用」。 */
    table[def.urlLang] = def.i18nKey;
  }
  for (const [alias, code] of Object.entries(LEGACY_URL_LANG_ALIASES)) {
    table[alias as PublicUrlLang] = code;
  }
  return table;
})();

const LOCALE_TO_PUBLIC_URL_LANG: Record<PublicSiteLocaleCode, CanonicalPublicUrlLang> = (() => {
  const table = {} as Record<PublicSiteLocaleCode, CanonicalPublicUrlLang>;
  for (const def of LOCALE_DEFINITIONS) {
    table[def.code] = def.urlLang;
  }
  return table;
})();

export function publicUrlLangForLocale(locale: PublicSiteLocaleCode): CanonicalPublicUrlLang {
  return LOCALE_TO_PUBLIC_URL_LANG[locale];
}

export function defaultPublicUrlLang(defaultLocale: "zh-CN" | "en-US"): "en-us" | "zh-cn" {
  return defaultLocale === PUBLIC_SITE_LOCALES.EN_US ? PUBLIC_URL_LANGS.EN_US : PUBLIC_URL_LANGS.ZH_CN;
}

/**
 * 语言前缀匹配正则。
 *
 * 由注册表按**前缀长度降序**生成，因此长前缀（`zh-hant`）永远优先于
 * 短前缀（`zh`）匹配。新增语种自动生效，无需手工维护交替分支顺序。
 */
const PUBLIC_LANG_PREFIX_PATTERN = buildUrlLangPattern();

export function matchPublicLangPrefix(pathname: string): { lang: PublicUrlLang; rest: string } | null {
  const m = pathname.match(PUBLIC_LANG_PREFIX_PATTERN);
  if (!m) return null;
  const lang = m[1] as PublicUrlLang;
  const rest = "/" + (m[3] ?? "");
  return { lang, rest: rest === "//" ? "/" : rest };
}

export function stripPublicSiteLocalePrefix(pathname: string): string {
  const existing = matchPublicLangPrefix(pathname);
  const normalized = existing ? existing.rest : pathname || "/";
  return normalized === "//" ? "/" : normalized;
}

export function shouldLocalizePublicPath(pathWithoutLang: string): boolean {
  if (pathWithoutLang === "/") return true;
  return PUBLIC_LOCALIZED_PATH_PREFIXES.some((prefix) => (
    pathWithoutLang === prefix || pathWithoutLang.startsWith(`${prefix}/`)
  ));
}

/* ──────────────────────────────────────────────────────────────
 * 注册表派生的只读集合（供 SEO / 路由生成等场景遍历）
 * ────────────────────────────────────────────────────────────── */

/** 参与 SEO 前缀与 hreflang 的全部规范 URL 前缀。 */
export const SEO_PREFIXED_URL_LANGS: readonly CanonicalPublicUrlLang[] = LOCALE_DEFINITIONS
  .filter((def) => def.seoPrefixed)
  .map((def) => def.urlLang);

/** 全部规范 URL 前缀（不含历史别名）。 */
export const ALL_CANONICAL_URL_LANGS: readonly CanonicalPublicUrlLang[] = ALL_URL_LANGS;

/** 在语言切换器中展示的 locale。 */
export const SWITCHER_VISIBLE_LOCALES: readonly PublicSiteLocaleCode[] = RUNTIME_LOCALE_DEFINITIONS
  .map((definition) => definition.code);

export { localeDefinition, resolveUrlLangToLocale };
