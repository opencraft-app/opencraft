import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';

export type PublicUrlLang = 'en-us' | 'zh-cn' | 'zh-sg' | 'zh-hant';

export type PublicRouteLocale = {
  locale: PublicSiteLocale;
  localized: boolean;
};

// ---------------------------------------------------------------------------
// Locale constants (single source of truth for next-site layer)
// ---------------------------------------------------------------------------
// 说明：`next-site/*` 与 `src/*` 是两条独立打包管线，故在此层各自维护一份
// 命名常量镜像；数值必须与 `@/lib/public-site-routing.PUBLIC_SITE_LOCALES` 保持一致。
export const EN_US_LOCALE: PublicSiteLocale = 'en-US';
export const ZH_CN_LOCALE: PublicSiteLocale = 'zh-CN';
export const ZH_SG_LOCALE: PublicSiteLocale = 'zh-SG';
export const ZH_HANT_LOCALE: PublicSiteLocale = 'zh-Hant';

export const EN_US_URL_LANG = 'en-us' satisfies PublicUrlLang;
export const ZH_CN_URL_LANG = 'zh-cn' satisfies PublicUrlLang;
export const ZH_SG_URL_LANG = 'zh-sg' satisfies PublicUrlLang;
export const ZH_HANT_URL_LANG = 'zh-hant' satisfies PublicUrlLang;

export const DEFAULT_PUBLIC_URL_LANG: PublicUrlLang = isGlobal ? EN_US_URL_LANG : ZH_CN_URL_LANG;
export const DEFAULT_PUBLIC_SITE_LOCALE: PublicSiteLocale = isGlobal ? EN_US_LOCALE : ZH_CN_LOCALE;
export const DEFAULT_PUBLIC_DOCS_LOCALE: PublicUrlLang = DEFAULT_PUBLIC_URL_LANG;

export const DEFAULT_PUBLIC_ROUTE_LOCALE: PublicRouteLocale = {
  locale: DEFAULT_PUBLIC_SITE_LOCALE,
  localized: false,
};

export const PUBLIC_URL_LANGS = [
  EN_US_URL_LANG,
  ZH_CN_URL_LANG,
  ZH_SG_URL_LANG,
  ZH_HANT_URL_LANG,
] as const satisfies readonly PublicUrlLang[];

const LANG_TO_LOCALE: Record<PublicUrlLang, PublicSiteLocale> = {
  [EN_US_URL_LANG]: EN_US_LOCALE,
  [ZH_CN_URL_LANG]: ZH_CN_LOCALE,
  [ZH_SG_URL_LANG]: ZH_SG_LOCALE,
  [ZH_HANT_URL_LANG]: ZH_HANT_LOCALE,
};

export function publicRouteLocaleFromLang(lang: string): PublicRouteLocale | null {
  if (!(PUBLIC_URL_LANGS as readonly string[]).includes(lang)) return null;
  return {
    locale: LANG_TO_LOCALE[lang as PublicUrlLang],
    localized: true,
  };
}
