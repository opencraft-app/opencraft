import { describe, expect, it } from 'vitest';

import {
  DOCS_SEARCH_LOCALES,
  resolveDocsSearchEndpoint,
  resolveDocsSearchLocale,
} from '../search-routing';

describe('docs search routing', () => {
  it('recognizes every published docs locale', () => {
    expect(DOCS_SEARCH_LOCALES).toEqual(['en-us', 'zh-cn', 'zh-sg', 'zh-hant', 'id-id']);
    expect(resolveDocsSearchLocale('/zh-hant/docs/overview', 'zh-cn', 'en-us')).toBe('zh-hant');
    expect(resolveDocsSearchLocale('/id-id/docs/overview', 'zh-cn', 'en-us')).toBe('id-id');
  });

  it('falls back to the build default for an unsupported locale', () => {
    expect(resolveDocsSearchLocale('/docs/overview', 'fr', 'zh-cn')).toBe('zh-cn');
  });

  it('loads only the selected locale index', () => {
    expect(resolveDocsSearchEndpoint('/api/search', 'en-us')).toBe('/api/search/en-us');
    expect(resolveDocsSearchEndpoint('/api/search/', 'zh-hant')).toBe('/api/search/zh-hant');
    expect(resolveDocsSearchEndpoint('/api/search/', 'id-id')).toBe('/api/search/id-id');
  });
});
