import { PUBLIC_URL_LANGS, type PublicUrlLang } from './public-locale';

export const DOCS_SEARCH_LOCALES = PUBLIC_URL_LANGS;

export type DocsSearchLocale = PublicUrlLang;

export function resolveDocsSearchLocale(
  pathname: string | null,
  contextLocale: unknown,
  fallbackLocale: DocsSearchLocale,
): DocsSearchLocale {
  const firstSegment = pathname?.split('/').filter(Boolean)[0];
  if (firstSegment && (DOCS_SEARCH_LOCALES as readonly string[]).includes(firstSegment)) {
    return firstSegment as DocsSearchLocale;
  }
  if (typeof contextLocale === 'string' && (DOCS_SEARCH_LOCALES as readonly string[]).includes(contextLocale)) {
    return contextLocale as DocsSearchLocale;
  }
  return fallbackLocale;
}

export function resolveDocsSearchEndpoint(baseApi: string, locale: DocsSearchLocale): string {
  return `${baseApi.replace(/\/$/, '')}/${locale}`;
}
