export type PublicSiteLocaleCode = "zh-CN" | "zh-SG" | "zh-Hant" | "en-US";
export type PublicUrlLang = "en" | "zh" | "en-us" | "zh-cn" | "zh-sg" | "zh-hant";
export type CanonicalPublicUrlLang = "en-us" | "zh-cn" | "zh-sg" | "zh-hant";

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
