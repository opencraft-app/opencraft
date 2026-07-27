import { docs } from 'collections/server';
import { defineI18n } from 'fumadocs-core/i18n';
import { loader } from 'fumadocs-core/source';

import { DEFAULT_PUBLIC_DOCS_LOCALE } from './public-locale';

const COMPARISON_FILE_PREFIX = 'compare/lightvela-vs-';

export const docsI18n = defineI18n({
  defaultLanguage: DEFAULT_PUBLIC_DOCS_LOCALE,
  languages: ['en-us', 'zh-cn', 'zh-sg'],
  parser: 'dir',
  hideLocale: 'default-locale',
});

export const source = loader({
  baseUrl: '/docs',
  i18n: docsI18n,
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [
      {
        file(node, filePath) {
          if (!filePath?.includes(COMPARISON_FILE_PREFIX)) return node;

          return {
            ...node,
            name: node.name.split(/[:：]/, 1)[0] ?? node.name,
          };
        },
      },
    ],
  },
});
