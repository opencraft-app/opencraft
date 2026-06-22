import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import type { ReactNode } from 'react';

import { source } from './source';
import type { DocsLocalePrefix } from './docs-page';

const ZH_FUMADOCS_TRANSLATIONS = {
  'Close Search(search dialog)(aria-label)': '关闭搜索',
  'No Headings(table of contents)': '暂无目录',
  'No results found(search dialog)': '没有找到结果',
  'On this page(table of contents)': '本页目录',
  'Open Search(search trigger)(aria-label)': '打开搜索',
  'Search(search dialog)': '搜索',
  'Search(search trigger)': '搜索文档',
};

export function LightVelaDocsLayout({
  children,
  contentLocale = 'zh-cn',
}: {
  children: ReactNode;
  contentLocale?: DocsLocalePrefix;
}) {
  const docsLocale = contentLocale ?? 'zh-cn';
  const translations = docsLocale === 'en-us' ? undefined : ZH_FUMADOCS_TRANSLATIONS;

  return (
    <div className="lv-docs-shell">
      <I18nProvider locale={docsLocale} translations={translations}>
        <DocsLayout
          tree={source.getPageTree(contentLocale)}
          nav={{
            enabled: false,
          }}
          i18n={false}
          themeSwitch={{
            enabled: false,
          }}
          sidebar={{
            className: 'lv-docs-sidebar',
            collapsible: false,
          }}
          containerProps={{
            className: 'lv-docs-layout',
          }}
        >
          {children}
        </DocsLayout>
      </I18nProvider>
    </div>
  );
}
