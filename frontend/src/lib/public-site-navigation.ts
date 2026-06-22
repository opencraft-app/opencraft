export type PublicSiteLocale = "zh-CN" | "zh-SG" | "en-US";
export type PublicDocsUrlLocale = "en-us" | "zh-cn" | "zh-sg";
export type PublicSiteSection = "overview" | "changelog" | "docs" | "about";

export type PublicSiteNavItem = {
  section: PublicSiteSection;
  href: string;
  label: Record<PublicSiteLocale, string>;
  cnOnly?: boolean;
};

export const PUBLIC_SITE_NAV_ITEMS: readonly PublicSiteNavItem[] = [
  { section: "overview", href: "/", label: { "zh-CN": "概览", "zh-SG": "概览", "en-US": "Overview" } },
  { section: "changelog", href: "/changelog", label: { "zh-CN": "更新日志", "zh-SG": "更新日志", "en-US": "Changelog" }, cnOnly: true },
  { section: "docs", href: "/docs/overview", label: { "zh-CN": "产品文档", "zh-SG": "产品文档", "en-US": "Docs" } },
  { section: "about", href: "/about", label: { "zh-CN": "关于我们", "zh-SG": "关于我们", "en-US": "About" } },
] as const;

const LOCALE_TO_DOCS_URL_LOCALE: Record<PublicSiteLocale, PublicDocsUrlLocale> = {
  "en-US": "en-us",
  "zh-CN": "zh-cn",
  "zh-SG": "zh-sg",
};

const LOCALE_TO_PUBLIC_ROOT_LANG: Record<PublicSiteLocale, "en-us" | "zh-cn" | "zh-sg"> = {
  "en-US": "en-us",
  "zh-CN": "zh-cn",
  "zh-SG": "zh-sg",
};

const LOCALIZED_PUBLIC_PREFIXES = ["/docs", "/about", "/privacy-policy", "/cookie-policy", "/open-source-licenses"] as const;

export function stripPublicSiteLocalePrefix(pathname: string): string {
  const withoutLeadingLocale = pathname.replace(/^\/(en-us|zh-cn|zh-sg|en|zh)(?=\/|$)/, "") || "/";
  const normalized = withoutLeadingLocale || "/";
  return normalized === "//" ? "/" : normalized;
}

function shouldLocalizePublicPath(pathWithoutLang: string): boolean {
  if (pathWithoutLang === "/") return true;
  return LOCALIZED_PUBLIC_PREFIXES.some((prefix) => (
    pathWithoutLang === prefix || pathWithoutLang.startsWith(`${prefix}/`)
  ));
}

export function publicSiteHref(
  href: string,
  locale: PublicSiteLocale,
  options: { localized?: boolean } = {},
): string {
  if (!options.localized) return href;
  if (!href.startsWith("/")) return href;

  const bare = stripPublicSiteLocalePrefix(href);
  if (!shouldLocalizePublicPath(bare)) return bare;

  const docsLocale = LOCALE_TO_DOCS_URL_LOCALE[locale];
  if (bare === "/docs" || bare.startsWith("/docs/")) {
    if (locale === "zh-CN") return bare;
    return `/${docsLocale}${bare}`;
  }
  const lang = LOCALE_TO_PUBLIC_ROOT_LANG[locale];
  if (bare === "/") return `/${lang}`;
  return `/${lang}${bare}`;
}

export function isPublicSiteNavActive(href: string, pathname: string): boolean {
  const activePath = stripPublicSiteLocalePrefix(pathname);
  const activeHref = stripPublicSiteLocalePrefix(href);
  return activeHref === "/" ? activePath === "/" : activePath === activeHref || activePath.startsWith(`${activeHref}/`);
}
