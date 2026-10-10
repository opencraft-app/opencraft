import { createTokenizer as createMandarinTokenizer } from '@orama/tokenizers/mandarin';
import type { Tokenizer } from '@orama/orama';

import type { DocsSearchLocale } from './search-routing';

export function createDocsSearchTokenizer(locale: DocsSearchLocale) {
  if (locale === 'th-th') {
    const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
    return {
      language: 'thai',
      normalizationCache: new Map<string, string>(),
      tokenize: (text: string) => [...new Set(
        Array.from(segmenter.segment(text.normalize('NFC')))
          .filter((part) => part.isWordLike)
          .map((part) => part.segment.toLocaleLowerCase('th')),
      )],
    } satisfies Tokenizer;
  }
  if (locale === 'en-us' || locale === 'ms-my') return undefined;
  return createMandarinTokenizer();
}
