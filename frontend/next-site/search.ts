import { createFromSource } from 'fumadocs-core/search/server';

import { source } from './source';
import { createLightVelaSearchTokenizer } from './search-tokenizer';

const searchSource = new Proxy(source, {
  get(target, prop, receiver) {
    if (prop !== 'getPages') {
      return Reflect.get(target, prop, receiver);
    }

    return () =>
      target
        .getPages()
        .filter((page) => !page.locale || page.path.startsWith(`${page.locale}/`));
  },
});

export const search = createFromSource(searchSource, {
  localeMap: {
    'en-us': {},
    'zh-cn': {},
    'zh-sg': {},
  },
  tokenizer: createLightVelaSearchTokenizer(),
});
