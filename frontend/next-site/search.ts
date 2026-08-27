import { createFromSource } from 'fumadocs-core/search/server';

import { source } from './source';
import { createDocsSearchTokenizer } from './search-tokenizer';
import type { DocsSearchLocale } from './search-routing';

function createLocaleSource(locale: DocsSearchLocale): typeof source {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (prop === '_i18n') return undefined;
      if (prop !== 'getPages') return Reflect.get(target, prop, receiver);

      return () =>
        target
          .getPages()
          .filter((page) => page.locale === locale && page.path.startsWith(`${locale}/`));
    },
  });
}

export function createLocaleSearch(locale: DocsSearchLocale) {
  return createFromSource(createLocaleSource(locale), {
    tokenizer: createDocsSearchTokenizer(locale),
  });
}
