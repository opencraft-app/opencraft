import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';
import {
  localeDefinitionByUrlLang,
  runtimeLocaleDefinitions,
  type UrlLang,
} from '@/i18n/locales.config';

export type PublicUrlLang = UrlLang;

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
export const ID_ID_LOCALE: PublicSiteLocale = 'id-ID';
export const ES_LOCALE: PublicSiteLocale = 'es';
export const JA_JP_LOCALE: PublicSiteLocale = 'ja-JP';
export const KO_KR_LOCALE: PublicSiteLocale = 'ko-KR';

export const EN_US_URL_LANG = 'en-us' satisfies PublicUrlLang;
export const ZH_CN_URL_LANG = 'zh-cn' satisfies PublicUrlLang;
export const ZH_SG_URL_LANG = 'zh-sg' satisfies PublicUrlLang;
export const ZH_HANT_URL_LANG = 'zh-hant' satisfies PublicUrlLang;
export const ID_ID_URL_LANG = 'id-id' satisfies PublicUrlLang;
export const ES_URL_LANG = 'es' satisfies PublicUrlLang;
export const JA_JP_URL_LANG = 'ja-jp' satisfies PublicUrlLang;
export const KO_KR_URL_LANG = 'ko-kr' satisfies PublicUrlLang;

export const DEFAULT_PUBLIC_URL_LANG: PublicUrlLang = isGlobal ? EN_US_URL_LANG : ZH_CN_URL_LANG;
export const DEFAULT_PUBLIC_SITE_LOCALE: PublicSiteLocale = isGlobal ? EN_US_LOCALE : ZH_CN_LOCALE;
export const DEFAULT_PUBLIC_DOCS_LOCALE: typeof EN_US_URL_LANG | typeof ZH_CN_URL_LANG = isGlobal
  ? EN_US_URL_LANG
  : ZH_CN_URL_LANG;

export const DEFAULT_PUBLIC_ROUTE_LOCALE: PublicRouteLocale = {
  locale: DEFAULT_PUBLIC_SITE_LOCALE,
  localized: false,
};

const RUNTIME_LOCALE_DEFINITIONS = runtimeLocaleDefinitions({
  region: isGlobal ? 'global' : 'cn',
  isProduction: process.env.NODE_ENV === 'production',
  previewLocales: process.env.NEXT_PUBLIC_PREVIEW_LOCALES,
});

export const PUBLIC_URL_LANGS: readonly PublicUrlLang[] = RUNTIME_LOCALE_DEFINITIONS
  .map((definition) => definition.urlLang);

/**
 * 运行时公开路由白名单。
 *
 * 公开运行时路由与切换器共用注册表发布门禁。日语/韩语准备期间不会因
 * 已注册而意外暴露；当两项发布标志同时打开时会自动进入此集合。
 */
export const PUBLIC_RUNTIME_URL_LANGS = PUBLIC_URL_LANGS;

export function publicRouteLocaleFromLang(lang: string): PublicRouteLocale | null {
  if (!(PUBLIC_RUNTIME_URL_LANGS as readonly string[]).includes(lang)) return null;
  const definition = localeDefinitionByUrlLang(lang);
  if (!definition) return null;
  return {
    locale: definition.code,
    localized: true,
  };
}
