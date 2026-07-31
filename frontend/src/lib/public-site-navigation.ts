import { DEFAULT_LOCALE, isGlobal } from "@/lib/region";
import {
  defaultPublicUrlLang,
  publicUrlLangForLocale,
  shouldLocalizePublicPath,
  stripPublicSiteLocalePrefix,
} from "@/lib/public-site-routing";

export type PublicSiteLocale = "zh-CN" | "zh-SG" | "en-US";
export type PublicSiteSection = "overview" | "pricing" | "changelog" | "docs" | "blog" | "about" | "support";

export type PublicSiteNavItem = {
  section: PublicSiteSection;
  href: string;
  label: Record<PublicSiteLocale, string>;
  cnOnly?: boolean;
};

export const PUBLIC_SITE_NAV_ITEMS: readonly PublicSiteNavItem[] = [
  { section: "overview", href: "/", label: { "zh-CN": "概览", "zh-SG": "概览", "en-US": "Overview" } },
  // 功能点2a：「定价」入口国内站与国际站均展示，指向订阅套餐页 /subscribe；未登录可浏览静态价格。
  { section: "pricing", href: "/subscribe", label: { "zh-CN": "定价", "zh-SG": "定价", "en-US": "Pricing" } },
  { section: "changelog", href: "/changelog", label: { "zh-CN": "更新日志", "zh-SG": "更新日志", "en-US": "Changelog" } },
  { section: "docs", href: "/docs/overview", label: { "zh-CN": "产品文档", "zh-SG": "产品文档", "en-US": "Docs" } },
  { section: "blog", href: "/blog", label: { "zh-CN": "科普", "zh-SG": "科普", "en-US": "Blog" } },
  { section: "about", href: "/about", label: { "zh-CN": "关于我们", "zh-SG": "关于我们", "en-US": "About" } },
  // 「产品反馈」不再作为顶部导航项，改为从用户头像菜单入口进入 /support。
  // 页面本身与 legal-footer 链接保留；section 类型继续保留 "support"，
  // 以兼容 /support 路径的 nav 高亮判定与其它引用。
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
