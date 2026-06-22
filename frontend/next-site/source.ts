import { docs } from 'collections/server';
import { defineI18n } from 'fumadocs-core/i18n';
import { loader } from 'fumadocs-core/source';

export const docsI18n = defineI18n({
  defaultLanguage: 'zh-cn',
  languages: ['en-us', 'zh-cn', 'zh-sg'],
  parser: 'dir',
  hideLocale: 'default-locale',
});

export const source = loader({
  baseUrl: '/docs',
  i18n: docsI18n,
  source: docs.toFumadocsSource(),
});
