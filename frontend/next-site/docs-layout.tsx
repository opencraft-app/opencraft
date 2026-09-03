import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import type { ReactNode } from 'react';

import { source } from './source';
import type { DocsLocalePrefix } from './docs-page';
import { EN_US_URL_LANG, ES_URL_LANG, ID_ID_URL_LANG, JA_JP_URL_LANG, KO_KR_URL_LANG, ZH_CN_URL_LANG, ZH_HANT_URL_LANG } from './public-locale';

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

const ID_FUMADOCS_TRANSLATIONS = {
  'Close Search(search dialog)(aria-label)': 'Tutup pencarian',
  'No Headings(table of contents)': 'Belum ada daftar isi',
  'No results found(search dialog)': 'Tidak ada hasil',
  'On this page(table of contents)': 'Di halaman ini',
  'Open Search(search trigger)(aria-label)': 'Buka pencarian',
  'Search(search dialog)': 'Cari',
  'Search(search trigger)': 'Cari dokumentasi',
};

const ES_FUMADOCS_TRANSLATIONS = {
  'Close Search(search dialog)(aria-label)': 'Cerrar búsqueda',
  'No Headings(table of contents)': 'No hay encabezados',
  'No results found(search dialog)': 'No se encontraron resultados',
  'On this page(table of contents)': 'En esta página',
  'Open Search(search trigger)(aria-label)': 'Abrir búsqueda',
  'Search(search dialog)': 'Buscar',
  'Search(search trigger)': 'Buscar documentación',
};

const JA_FUMADOCS_TRANSLATIONS = {
  'Close Search(search dialog)(aria-label)': '検索を閉じる',
  'No Headings(table of contents)': '見出しはありません',
  'No results found(search dialog)': '結果が見つかりません',
  'On this page(table of contents)': 'このページの内容',
  'Open Search(search trigger)(aria-label)': '検索を開く',
  'Search(search dialog)': '検索',
  'Search(search trigger)': 'ドキュメントを検索',
};

const KO_FUMADOCS_TRANSLATIONS = {
  'Close Search(search dialog)(aria-label)': '검색 닫기',
  'No Headings(table of contents)': '제목이 없습니다',
  'No results found(search dialog)': '검색 결과가 없습니다',
  'On this page(table of contents)': '이 페이지에서',
  'Open Search(search trigger)(aria-label)': '검색 열기',
  'Search(search dialog)': '검색',
  'Search(search trigger)': '문서 검색',
};

export function fumadocsTranslations(docsLocale: DocsLocalePrefix) {
  if (docsLocale === EN_US_URL_LANG) return undefined;
  if (docsLocale === ID_ID_URL_LANG) return ID_FUMADOCS_TRANSLATIONS;
  if (docsLocale === ES_URL_LANG) return ES_FUMADOCS_TRANSLATIONS;
  if (docsLocale === JA_JP_URL_LANG) return JA_FUMADOCS_TRANSLATIONS;
  if (docsLocale === KO_KR_URL_LANG) return KO_FUMADOCS_TRANSLATIONS;
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
