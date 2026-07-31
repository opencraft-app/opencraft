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
    // 与 `source.ts` 的 `docsI18n.languages` 保持一致；缺失该条目时 fumadocs 会退回
    // 到把 language 字符串传给 orama 的 create()，与自定义 tokenizer 冲突并触发
    // `NO_LANGUAGE_WITH_CUSTOM_TOKENIZER` 构建报错。
    'zh-hant': {},
  },
  tokenizer: createLightVelaSearchTokenizer(),
});
