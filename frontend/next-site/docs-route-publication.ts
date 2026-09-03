import {
  LOCALE_DEFINITIONS,
  runtimeLocaleDefinitions,
  type LocaleDefinition,
} from '@/i18n/locales.config';
import {
  DOCS_ROUTE_LOCALES,
  type DocsRouteLocale,
} from '@next-site/docs-route-manifest';
import {
  EN_US_URL_LANG,
  PUBLIC_RUNTIME_URL_LANGS,
  ZH_CN_URL_LANG,
} from '@next-site/public-locale';

/** Fumadocs 只接收既在文档 manifest、又在当前运行时开放的 locale。 */
export function docsI18nLanguagesForRuntime(
  runtimeUrlLangs: readonly string[] = PUBLIC_RUNTIME_URL_LANGS,
): readonly DocsRouteLocale[] {
  const runtime = new Set(runtimeUrlLangs);
  return DOCS_ROUTE_LOCALES.filter((lang) => runtime.has(lang));
}

/**
 * 区域文档路由由注册表发布门禁和真实文档清单共同派生。
 * 国际站默认英文使用裸 `/docs`，`zh-cn` 也不生成重复前缀路由；
 * 国内站始终只使用裸中文文档路由。
 */
export function docsRouteLocalesForRegion(
  region: 'cn' | 'global',
  definitions: readonly LocaleDefinition[] = LOCALE_DEFINITIONS,
  runtime: {
    readonly isProduction: boolean;
    readonly previewLocales?: string | null;
  } = {
    isProduction: process.env.NODE_ENV === 'production',
    previewLocales: process.env.NEXT_PUBLIC_PREVIEW_LOCALES,
  },
): readonly DocsRouteLocale[] {
  if (region === 'cn') return [];

  const published = new Set<string>(runtimeLocaleDefinitions({
    region,
    definitions,
    ...runtime,
  }).map((definition) => definition.urlLang));
  return DOCS_ROUTE_LOCALES.filter((lang) => (
    lang !== EN_US_URL_LANG
    && lang !== ZH_CN_URL_LANG
    && published.has(lang)
  ));
}
