import { DEFAULT_LOCALE, isGlobal } from "@/lib/region";
import {
  defaultPublicUrlLang,
  PUBLIC_SITE_LOCALES,
  PUBLIC_URL_LANGS,
  publicUrlLangForLocale,
  shouldLocalizePublicPath,
  stripPublicSiteLocalePrefix,
} from "@/lib/public-site-routing";

export type PublicSiteLocale = "zh-CN" | "zh-SG" | "zh-Hant" | "en-US";
export type PublicSiteSection = "overview" | "pricing" | "changelog" | "docs" | "blog" | "about" | "support";

export type PublicSiteNavItem = {
  section: PublicSiteSection;
  href: string;
  label: Record<PublicSiteLocale, string>;
  cnOnly?: boolean;
};

// 用一个工厂快捷构造多语言 label，避免对象字面量里再出现 4 个 locale 魔法字符串键。
const label = (zhCN: string, zhSG: string, zhHant: string, enUS: string): Record<PublicSiteLocale, string> => ({
  [PUBLIC_SITE_LOCALES.ZH_CN]: zhCN,
  [PUBLIC_SITE_LOCALES.ZH_SG]: zhSG,
  [PUBLIC_SITE_LOCALES.ZH_HANT]: zhHant,
  [PUBLIC_SITE_LOCALES.EN_US]: enUS,
});

export const PUBLIC_SITE_NAV_ITEMS: readonly PublicSiteNavItem[] = [
  { section: "overview", href: "/", label: label("概览", "概览", "概覽", "Overview") },
  // 「定价」入口国内站与国际站均展示：指向订阅套餐页 /subscribe，未登录可浏览静态价格。
  { section: "pricing", href: "/subscribe", label: label("定价", "定价", "定價", "Pricing") },
  { section: "changelog", href: "/changelog", label: label("更新日志", "更新日志", "更新日誌", "Changelog") },
  { section: "docs", href: "/docs/overview", label: label("产品文档", "产品文档", "產品文檔", "Docs") },
  { section: "blog", href: "/blog", label: label("科普", "科普", "科普", "Blog") },
  { section: "about", href: "/about", label: label("关于我们", "关于我们", "關於我們", "About") },
  // 「产品反馈」不再作为顶部导航项，改为从用户头像菜单入口进入 /support。
  // 页面本身与 legal-footer 链接保留；section 类型继续保留 "support"，
  // 以兼容 /support 路径的 nav 高亮判定与其它引用。
] as const;

const DEFAULT_PUBLIC_URL_LOCALE = defaultPublicUrlLang(DEFAULT_LOCALE);

function publicUrlLangForSiteLocale(locale: PublicSiteLocale): string {
  if (isGlobal && locale === PUBLIC_SITE_LOCALES.ZH_HANT) return PUBLIC_URL_LANGS.ZH_HANT;
  if (isGlobal && locale.startsWith("zh")) return PUBLIC_URL_LANGS.ZH_SG;
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
