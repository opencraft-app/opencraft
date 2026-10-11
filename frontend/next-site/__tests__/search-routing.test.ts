import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DOCS_SEARCH_LOCALES,
  resolveDocsSearchEndpoint,
  resolveDocsSearchLocale,
} from '../search-routing';

describe('docs search routing', () => {
  it('routes Thai search to its own exported index', () => {
    expect(resolveDocsSearchLocale('/th-th/docs/overview', 'en-us', 'en-us')).toBe('th-th');
    expect(resolveDocsSearchEndpoint('/api/search/', 'th-th')).toBe('/api/search/th-th');
    expect(existsSync(resolve('src/app/api/search/th-th/route.next.ts'))).toBe(true);
  });

  it('recognizes every published docs locale', () => {
    expect(DOCS_SEARCH_LOCALES).toEqual(['en-us', 'zh-cn', 'zh-sg', 'zh-hant', 'id-id', 'ms-my', 'th-th', 'es', 'ja-jp', 'ko-kr']);
    expect(resolveDocsSearchLocale('/ms-my/docs/overview', 'en-us', 'en-us')).toBe('ms-my');
    expect(resolveDocsSearchLocale('/zh-hant/docs/overview', 'zh-cn', 'en-us')).toBe('zh-hant');
    expect(resolveDocsSearchLocale('/id-id/docs/overview', 'zh-cn', 'en-us')).toBe('id-id');
    expect(resolveDocsSearchLocale('/es/docs/overview', 'en-us', 'en-us')).toBe('es');
  });

  it('falls back to the build default for an unsupported locale', () => {
    expect(resolveDocsSearchLocale('/docs/overview', 'fr', 'zh-cn')).toBe('zh-cn');
  });

  it('loads only the selected locale index', () => {
    expect(resolveDocsSearchEndpoint('/api/search', 'en-us')).toBe('/api/search/en-us');
    expect(resolveDocsSearchEndpoint('/api/search/', 'zh-hant')).toBe('/api/search/zh-hant');
    expect(resolveDocsSearchEndpoint('/api/search/', 'id-id')).toBe('/api/search/id-id');
    expect(resolveDocsSearchEndpoint('/api/search/', 'es')).toBe('/api/search/es');
    expect(resolveDocsSearchEndpoint('/api/search/', 'ms-my')).toBe('/api/search/ms-my');
    expect(existsSync(resolve('src/app/api/search/ms-my/route.next.ts'))).toBe(true);
    expect(existsSync(resolve('src/app/api/search/es/route.next.ts'))).toBe(true);
  });
});
