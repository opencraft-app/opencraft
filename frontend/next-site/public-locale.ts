import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';

export type PublicUrlLang = 'en-us' | 'zh-cn' | 'zh-sg';

export type PublicRouteLocale = {
  locale: PublicSiteLocale;
  localized: boolean;
};

export const EN_US_LOCALE: PublicSiteLocale = 'en-US';
export const ZH_CN_LOCALE: PublicSiteLocale = 'zh-CN';
export const DEFAULT_PUBLIC_URL_LANG: PublicUrlLang = isGlobal ? 'en-us' : 'zh-cn';
export const DEFAULT_PUBLIC_SITE_LOCALE: PublicSiteLocale = isGlobal ? EN_US_LOCALE : ZH_CN_LOCALE;
export const DEFAULT_PUBLIC_DOCS_LOCALE: PublicUrlLang = DEFAULT_PUBLIC_URL_LANG;

export const DEFAULT_PUBLIC_ROUTE_LOCALE: PublicRouteLocale = {
  locale: DEFAULT_PUBLIC_SITE_LOCALE,
  localized: false,
};

export const PUBLIC_URL_LANGS = ['en-us', 'zh-cn', 'zh-sg'] as const satisfies readonly PublicUrlLang[];

const LANG_TO_LOCALE: Record<PublicUrlLang, PublicSiteLocale> = {
  'en-us': 'en-US',
  'zh-cn': 'zh-CN',
  'zh-sg': 'zh-SG',
};

export function publicRouteLocaleFromLang(lang: string): PublicRouteLocale | null {
  if (!(PUBLIC_URL_LANGS as readonly string[]).includes(lang)) return null;
  return {
    locale: LANG_TO_LOCALE[lang as PublicUrlLang],
    localized: true,
  };
}
