import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DOCS_SEARCH_LOCALES,
  resolveDocsSearchEndpoint,
  resolveDocsSearchLocale,
} from '../search-routing';

describe('docs search routing', () => {
  it('recognizes every published docs locale', () => {
    expect(DOCS_SEARCH_LOCALES).toEqual(['en-us', 'zh-cn', 'zh-sg', 'zh-hant', 'id-id', 'es']);
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
    expect(existsSync(resolve('src/app/api/search/es/route.next.ts'))).toBe(true);
  });
});
