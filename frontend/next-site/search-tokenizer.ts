import { createTokenizer as createMandarinTokenizer } from '@orama/tokenizers/mandarin';

import type { DocsSearchLocale } from './search-routing';

export function createDocsSearchTokenizer(locale: DocsSearchLocale) {
  if (locale === 'en-us') return undefined;
  return createMandarinTokenizer();
}
