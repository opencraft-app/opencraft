import { DEFAULT_LOCALE, isGlobal } from "@/lib/region";
import {
  defaultPublicUrlLang,
  publicUrlLangForLocale,
  shouldLocalizePublicPath,
  stripPublicSiteLocalePrefix,
} from "@/lib/public-site-routing";

export type PublicSiteLocale = "zh-CN" | "zh-SG" | "en-US";
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

const DEFAULT_PUBLIC_URL_LOCALE = defaultPublicUrlLang(DEFAULT_LOCALE);

function publicUrlLangForSiteLocale(locale: PublicSiteLocale): string {
  if (isGlobal && locale.startsWith("zh")) return "zh-sg";
  return publicUrlLangForLocale(locale);
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

  const docsLocale = publicUrlLangForSiteLocale(locale);
  if (bare === "/docs" || bare.startsWith("/docs/")) {
    return docsLocale === DEFAULT_PUBLIC_URL_LOCALE ? bare : `/${docsLocale}${bare}`;
  }
  const lang = publicUrlLangForSiteLocale(locale);
  if (lang === DEFAULT_PUBLIC_URL_LOCALE) return bare;
  if (bare === "/") return `/${lang}`;
  return `/${lang}${bare}`;
}

export function isPublicSiteNavActive(href: string, pathname: string): boolean {
  const activePath = stripPublicSiteLocalePrefix(pathname);
  const activeHref = stripPublicSiteLocalePrefix(href);
  return activeHref === "/" ? activePath === "/" : activePath === activeHref || activePath.startsWith(`${activeHref}/`);
}
