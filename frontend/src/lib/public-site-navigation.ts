import { DEFAULT_LOCALE, isGlobal } from "@/lib/region";
import {
  type CanonicalPublicUrlLang,
  defaultPublicUrlLang,
  PUBLIC_SITE_LOCALES,
  type PublicSiteLocaleCode,
  PUBLIC_URL_LANGS,
  publicUrlLangForLocale,
  shouldLocalizePublicPath,
  stripPublicSiteLocalePrefix,
} from "@/lib/public-site-routing";

/**
 * 公开站 locale。
 *
 * 从 `@/i18n/locales.config` 注册表派生，不再手工维护联合类型。
 * 这是类型穷举保护的关键：任何 `Record<PublicSiteLocale, T>` 在注册表
 * 新增语种后若未补齐条目，`tsc --noEmit` 会直接报错，从而把「漏配语种」
 * 从线上静默降级前移为编译期失败。
 */
export type PublicSiteLocale = PublicSiteLocaleCode;
export type PublicSiteSection = "overview" | "pricing" | "changelog" | "docs" | "about" | "support";

export type PublicSiteNavItem = {
  section: PublicSiteSection;
  href: string;
  label: Record<PublicSiteLocale, string>;
  cnOnly?: boolean;
};

/**
 * 多语言 label 构造器。
 *
 * ⚠️ 刻意使用**具名键**而非位置参数。早期实现是
 * `label(zhCN, zhSG, zhHant, enUS, idID)` 形式，5 个同类型位置参数已经
 * 容易错位；扩展到 8 个语种后位置参数几乎必然出错，且传错顺序不会
 * 编译报错，只会让页面显示错误语言的文案。
 *
 * 由于返回类型是 `Record<PublicSiteLocale, string>`，注册表新增语种后
 * 若此处未补齐对应键，`tsc` 会直接报错。
 */
const label = (entries: Record<PublicSiteLocale, string>): Record<PublicSiteLocale, string> => entries;

/** 简体中文与国际站简体别名（zh-SG）共用同一份文案，避免重复录入。 */
const zhSimplified = (text: string) => ({
  [PUBLIC_SITE_LOCALES.ZH_CN]: text,
  [PUBLIC_SITE_LOCALES.ZH_SG]: text,
});

export const PUBLIC_SITE_NAV_ITEMS: readonly PublicSiteNavItem[] = [
  {
    section: "overview",
    href: "/",
    label: label({
      ...zhSimplified("首页"),
      [PUBLIC_SITE_LOCALES.ZH_HANT]: "首頁",
      [PUBLIC_SITE_LOCALES.EN_US]: "Home",
      [PUBLIC_SITE_LOCALES.ID_ID]: "Beranda",
      [PUBLIC_SITE_LOCALES.ES]: "Inicio",
      [PUBLIC_SITE_LOCALES.JA_JP]: "ホーム",
      [PUBLIC_SITE_LOCALES.KO_KR]: "홈",
    }),
  },
  // 「定价」入口国内站与国际站均展示：指向订阅套餐页 /subscribe，未登录可浏览静态价格。
  {
    section: "pricing",
    href: "/subscribe",
    label: label({
      ...zhSimplified("定价"),
      [PUBLIC_SITE_LOCALES.ZH_HANT]: "定價",
      [PUBLIC_SITE_LOCALES.EN_US]: "Pricing",
      [PUBLIC_SITE_LOCALES.ID_ID]: "Harga",
      [PUBLIC_SITE_LOCALES.ES]: "Precios",
      [PUBLIC_SITE_LOCALES.JA_JP]: "料金",
      [PUBLIC_SITE_LOCALES.KO_KR]: "요금",
    }),
  },
  {
    section: "changelog",
    href: "/changelog",
    label: label({
      ...zhSimplified("更新日志"),
      [PUBLIC_SITE_LOCALES.ZH_HANT]: "更新日誌",
      [PUBLIC_SITE_LOCALES.EN_US]: "Changelog",
      [PUBLIC_SITE_LOCALES.ID_ID]: "Catatan Rilis",
      [PUBLIC_SITE_LOCALES.ES]: "Novedades",
      [PUBLIC_SITE_LOCALES.JA_JP]: "更新履歴",
      [PUBLIC_SITE_LOCALES.KO_KR]: "업데이트 내역",
    }),
  },
  {
    section: "docs",
    href: "/docs/overview",
    label: label({
      ...zhSimplified("产品文档"),
      [PUBLIC_SITE_LOCALES.ZH_HANT]: "產品文檔",
      [PUBLIC_SITE_LOCALES.EN_US]: "Docs",
      [PUBLIC_SITE_LOCALES.ID_ID]: "Dokumentasi",
      [PUBLIC_SITE_LOCALES.ES]: "Documentación",
      [PUBLIC_SITE_LOCALES.JA_JP]: "ドキュメント",
      [PUBLIC_SITE_LOCALES.KO_KR]: "문서",
    }),
  },
  {
    section: "about",
    href: "/about",
    label: label({
      ...zhSimplified("关于我们"),
      [PUBLIC_SITE_LOCALES.ZH_HANT]: "關於我們",
      [PUBLIC_SITE_LOCALES.EN_US]: "About",
      [PUBLIC_SITE_LOCALES.ID_ID]: "Tentang",
      [PUBLIC_SITE_LOCALES.ES]: "Acerca de",
      [PUBLIC_SITE_LOCALES.JA_JP]: "会社概要",
      [PUBLIC_SITE_LOCALES.KO_KR]: "회사 소개",
    }),
  },
  // 「产品反馈」不再作为顶部导航项，改为从用户头像菜单入口进入 /support。
  // 页面本身与 legal-footer 链接保留；section 类型继续保留 "support"，
  // 以兼容 /support 路径的 nav 高亮判定与其它引用。
] as const;

const DEFAULT_PUBLIC_URL_LOCALE = defaultPublicUrlLang(DEFAULT_LOCALE);

/**
 * 国际站导航链接使用的 URL 语言前缀。
 *
 * ⚠️ 与 `region.ts` 的 `INTL_SEO_URL_LANG_BY_LOCALE` 语义一致，同样刻意
 * 使用 `Record` 全量查表替代原先的 `startsWith('zh')` 猜测分支：漏配语种
 * 时编译报错，而非静默生成指向错误语言的导航链接。
 *
 * 既有语义保持不变：国际站简体（`zh-CN` / `zh-SG`）统一走 `zh-sg` 别名。
 */
const INTL_NAV_URL_LANG_BY_LOCALE: Record<PublicSiteLocale, CanonicalPublicUrlLang> = {
  "en-US": PUBLIC_URL_LANGS.EN_US,
  "zh-CN": PUBLIC_URL_LANGS.ZH_SG,
  "zh-SG": PUBLIC_URL_LANGS.ZH_SG,
  "zh-Hant": PUBLIC_URL_LANGS.ZH_HANT,
  "id-ID": PUBLIC_URL_LANGS.ID_ID,
  es: PUBLIC_URL_LANGS.ES,
  "ja-JP": PUBLIC_URL_LANGS.JA_JP,
  "ko-KR": PUBLIC_URL_LANGS.KO_KR,
};

function publicUrlLangForSiteLocale(locale: PublicSiteLocale): string {
  if (isGlobal) return INTL_NAV_URL_LANG_BY_LOCALE[locale];
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
