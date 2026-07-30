import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import type { ReactNode } from 'react';

import { source } from './source';
import type { DocsLocalePrefix } from './docs-page';
import { EN_US_URL_LANG, ZH_CN_URL_LANG, ZH_HANT_URL_LANG } from './public-locale';

const ZH_FUMADOCS_TRANSLATIONS = {
  'Close Search(search dialog)(aria-label)': '关闭搜索',
  'No Headings(table of contents)': '暂无目录',
  'No results found(search dialog)': '没有找到结果',
  'On this page(table of contents)': '本页目录',
  'Open Search(search trigger)(aria-label)': '打开搜索',
  'Search(search dialog)': '搜索',
  'Search(search trigger)': '搜索文档',
};

const ZH_HANT_FUMADOCS_TRANSLATIONS = {
  'Close Search(search dialog)(aria-label)': '關閉搜尋',
  'No Headings(table of contents)': '暫無目錄',
  'No results found(search dialog)': '沒有找到結果',
  'On this page(table of contents)': '本頁目錄',
  'Open Search(search trigger)(aria-label)': '開啟搜尋',
  'Search(search dialog)': '搜尋',
  'Search(search trigger)': '搜尋文件',
};

function fumadocsTranslations(docsLocale: DocsLocalePrefix) {
  if (docsLocale === EN_US_URL_LANG) return undefined;
  if (docsLocale === ZH_HANT_URL_LANG) return ZH_HANT_FUMADOCS_TRANSLATIONS;
  return ZH_FUMADOCS_TRANSLATIONS;
}

export function LightVelaDocsLayout({
  children,
  contentLocale = ZH_CN_URL_LANG,
}: {
  children: ReactNode;
  contentLocale?: DocsLocalePrefix;
}) {
  const docsLocale = contentLocale ?? ZH_CN_URL_LANG;
  const translations = fumadocsTranslations(docsLocale);

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
