export type DocsLanguage = 'en' | 'zh';

export function normalizeLanguage(value: string | null | undefined): DocsLanguage | undefined {
  if (!value) return undefined;

  const normalized = value.toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh';
  return undefined;
}

export function languageFromRequest(request: Request): DocsLanguage {
  const url = new URL(request.url);
  const queryLanguage = normalizeLanguage(url.searchParams.get('lang'));
  if (queryLanguage) return queryLanguage;

  const cookieLanguage = request.headers
    .get('cookie')
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('mono2-docs-language='))
    ?.split('=')[1];
  const normalizedCookieLanguage = normalizeLanguage(cookieLanguage);
  if (normalizedCookieLanguage) return normalizedCookieLanguage;

  return normalizeLanguage(request.headers.get('accept-language')?.split(',')[0]) ?? 'zh';
}
