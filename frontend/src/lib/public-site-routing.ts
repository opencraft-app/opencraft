export type PublicSiteLocaleCode = "zh-CN" | "zh-SG" | "zh-Hant" | "en-US";
export type PublicUrlLang = "en" | "zh" | "en-us" | "zh-cn" | "zh-sg" | "zh-hant";
export type CanonicalPublicUrlLang = "en-us" | "zh-cn" | "zh-sg" | "zh-hant";

/**
 * 官网前端所有 locale / URL-lang 字符串的**唯一常量来源**。
 *
 * 用法：调用方应引用 `PUBLIC_SITE_LOCALES.ZH_HANT` 而不是硬编码 `'zh-Hant'`，
 * 避免大小写 / 连字符方向漂移（历史上出现过 `zh-hant` / `zh-HANT` 混用问题）。
 *
 * 与类型联动：`typeof PUBLIC_SITE_LOCALES[keyof …]` 天然等价于 `PublicSiteLocaleCode`。
 */
export const PUBLIC_SITE_LOCALES = {
  EN_US: "en-US",
  ZH_CN: "zh-CN",
  ZH_SG: "zh-SG",
  ZH_HANT: "zh-Hant",
} as const satisfies Record<string, PublicSiteLocaleCode>;

/** URL 前缀（小写连字符）—— 与 `next-site/source.ts` 的 `docsI18n.languages` 一一对应。 */
export const PUBLIC_URL_LANGS = {
  EN_US: "en-us",
  ZH_CN: "zh-cn",
  ZH_SG: "zh-sg",
  ZH_HANT: "zh-hant",
} as const satisfies Record<string, CanonicalPublicUrlLang>;

export const PUBLIC_LOCALIZED_PATH_PREFIXES = [
  "/docs",
  "/about",
  "/changelog",
  "/privacy-policy",
  "/cookie-policy",
  "/open-source-licenses",
] as const;

export const PUBLIC_URL_LANG_TO_LOCALE: Record<PublicUrlLang, "zh-CN" | "en-US" | "zh-Hant"> = {
  en: "en-US",
  "en-us": "en-US",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-hant": "zh-Hant",
};

const LOCALE_TO_PUBLIC_URL_LANG: Record<PublicSiteLocaleCode, CanonicalPublicUrlLang> = {
  "en-US": "en-us",
  "zh-CN": "zh-cn",
  "zh-SG": "zh-sg",
  "zh-Hant": "zh-hant",
};

export function publicUrlLangForLocale(locale: PublicSiteLocaleCode): CanonicalPublicUrlLang {
  return LOCALE_TO_PUBLIC_URL_LANG[locale];
}

export function defaultPublicUrlLang(defaultLocale: "zh-CN" | "en-US"): "en-us" | "zh-cn" {
  return defaultLocale === "en-US" ? "en-us" : "zh-cn";
}

export function matchPublicLangPrefix(pathname: string): { lang: PublicUrlLang; rest: string } | null {
  const m = pathname.match(/^\/(en-us|zh-cn|zh-sg|zh-hant|en|zh)(\/|$)(.*)$/);
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
