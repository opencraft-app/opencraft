import { docs } from 'collections/server';
import { defineI18n } from 'fumadocs-core/i18n';
import { loader } from 'fumadocs-core/source';

import { DEFAULT_PUBLIC_DOCS_LOCALE } from './public-locale';

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
});
