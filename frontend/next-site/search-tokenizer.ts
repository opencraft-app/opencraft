import { createTokenizer as createMandarinTokenizer } from '@orama/tokenizers/mandarin';

import type { DocsSearchLocale } from './search-routing';

export function createDocsSearchTokenizer(locale: DocsSearchLocale) {
  if (locale === 'en-us' || locale === 'ms-my') return undefined;
  return createMandarinTokenizer();
}
