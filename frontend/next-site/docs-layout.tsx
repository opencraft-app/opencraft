import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import type { Translations } from 'fumadocs-ui/i18n';
import type { ReactNode } from 'react';

import { source } from './source';
import type { DocsLocalePrefix } from './docs-page';
import { EN_US_URL_LANG, ES_URL_LANG, ID_ID_URL_LANG, MS_MY_URL_LANG, TH_TH_URL_LANG, JA_JP_URL_LANG, KO_KR_URL_LANG, ZH_CN_URL_LANG, ZH_HANT_URL_LANG } from './public-locale';

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

const MS_FUMADOCS_TRANSLATIONS = {
  'Back to Home(404 page)': 'Kembali ke laman utama',
  'Choose a language(language switcher)': 'Pilih bahasa',
  'Choose a language(language switcher)(aria-label)': 'Pilih bahasa',
  'Close Banner(banner)(aria-label)': 'Tutup sepanduk',
  'Collapse Sidebar(sidebar)(aria-label)': 'Tutup bar sisi',
  'Copied Text(code block)(aria-label)': 'Teks disalin',
  'Copy Anchor Link(heading anchor)(aria-label)': 'Salin pautan tajuk',
  'Copy Link(accordion)(aria-label)': 'Salin pautan',
  'Copy Markdown(page actions)': 'Salin Markdown',
  'Copy Text(code block)(aria-label)': 'Salin teks',
  'Dark(theme switcher)(aria-label)': 'Gelap',
  'Default(type table)': 'Lalai',
  'Edit on GitHub(edit page)': 'Edit di GitHub',
  'Last updated on(page footer)': 'Dikemas kini pada',
  'Light(theme switcher)(aria-label)': 'Terang',
  'Next Page(pagination)': 'Halaman seterusnya',
  'Open Sidebar(sidebar)(aria-label)': 'Buka bar sisi',
  'Open in ChatGPT(page actions)': 'Buka dalam ChatGPT',
  'Open in Claude(page actions)': 'Buka dalam Claude',
  'Open in Cursor(page actions)': 'Buka dalam Cursor',
  'Open in GitHub(page actions)': 'Buka dalam GitHub',
  'Open in Scira AI(page actions)': 'Buka dalam Scira AI',
  'Open(page actions)': 'Buka',
  'Page Not Found(404 page)': 'Halaman tidak dijumpai',
  'Parameters(type table)': 'Parameter',
  'Previous Page(pagination)': 'Halaman sebelumnya',
  'Prop(type table)': 'Sifat',
  'Read {url}, I want to ask questions about it.(page actions)': 'Baca {url}, saya ingin bertanya tentangnya.',
  'Returns(type table)': 'Nilai pulangan',
  'System(theme switcher)(aria-label)': 'Sistem',
  'Table of Contents(inline table of contents)': 'Isi kandungan',
  'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)': 'Halaman yang anda cari mungkin telah dipadamkan, dinamakan semula atau tidak tersedia buat sementara waktu.',
  'Toggle Menu(mobile menu)(aria-label)': 'Buka atau tutup menu',
  'Toggle Theme(theme switcher)(aria-label)': 'Tukar tema',
  'Type(type table)': 'Jenis',
  'View as Markdown(page actions)': 'Lihat sebagai Markdown',
  displayName: 'Bahasa Melayu',
  'Close Search(search dialog)(aria-label)': 'Tutup carian',
  'No Headings(table of contents)': 'Tiada tajuk',
  'No results found(search dialog)': 'Tiada hasil dijumpai',
  'On this page(table of contents)': 'Pada halaman ini',
  'Open Search(search trigger)(aria-label)': 'Buka carian',
  'Search(search dialog)': 'Cari',
  'Search(search trigger)': 'Cari dokumentasi',
} satisfies Translations;

const TH_FUMADOCS_TRANSLATIONS = {
  'Back to Home(404 page)': "กลับไปหน้าหลัก",
  'Choose a language(language switcher)': "เลือกภาษา",
  'Choose a language(language switcher)(aria-label)': "เลือกภาษา",
  'Close Banner(banner)(aria-label)': "ปิดแบนเนอร์",
  'Collapse Sidebar(sidebar)(aria-label)': "ย่อแถบด้านข้าง",
  'Copied Text(code block)(aria-label)': "ข้อความที่ถูกคัดลอก",
  'Copy Anchor Link(heading anchor)(aria-label)': "คัดลอกลิงก์แองเคอร์",
  'Copy Link(accordion)(aria-label)': "คัดลอกลิงก์",
  'Copy Markdown(page actions)': "คัดลอก Markdown",
  'Copy Text(code block)(aria-label)': "คัดลอกข้อความ",
  'Dark(theme switcher)(aria-label)': "มืด",
  'Default(type table)': "ค่าเริ่มต้น",
  'Edit on GitHub(edit page)': "แก้ไขบน GitHub",
  'Last updated on(page footer)': "อัปเดตล่าสุดเมื่อ",
  'Light(theme switcher)(aria-label)': "แสง",
  'Next Page(pagination)': "หน้าถัดไป",
  'Open Sidebar(sidebar)(aria-label)': "เปิดแถบด้านข้าง",
  'Open in ChatGPT(page actions)': "เปิดใน ChatGPT",
  'Open in Claude(page actions)': "เปิดใน Claude",
  'Open in Cursor(page actions)': "เปิดในเคอร์เซอร์",
  'Open in GitHub(page actions)': "เปิดใน GitHub",
  'Open in Scira AI(page actions)': "เปิดใน Scira AI",
  'Open(page actions)': "เปิด",
  'Page Not Found(404 page)': "ไม่พบหน้าที่ต้องการ",
  'Parameters(type table)': "พารามิเตอร์",
  'Previous Page(pagination)': "หน้าก่อนหน้า",
  'Prop(type table)': "พร็อพ",
  'Read {url}, I want to ask questions about it.(page actions)': "อ่าน {url} ฉันต้องการถามคำถามเกี่ยวกับมัน",
  'Returns(type table)': "ผลตอบแทน",
  'System(theme switcher)(aria-label)': "ระบบ",
  'Table of Contents(inline table of contents)': "สารบัญ",
  'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)': "หน้าที่คุณกำลังค้นหาอาจถูกลบ ถูกเปลี่ยนชื่อ หรือไม่สามารถใช้งานได้ชั่วคราว",
  'Toggle Menu(mobile menu)(aria-label)': "สลับเมนู",
  'Toggle Theme(theme switcher)(aria-label)': "สลับธีม",
  'Type(type table)': "ประเภท",
  'View as Markdown(page actions)': "ดูเป็นมาร์กดาวน์",
  displayName: "ไทย",
  'Close Search(search dialog)(aria-label)': "ปิดการค้นหา",
  'No Headings(table of contents)': "ไม่มีหัวข้อ",
  'No results found(search dialog)': "ไม่พบผลลัพธ์",
  'On this page(table of contents)': "บนหน้านี้",
  'Open Search(search trigger)(aria-label)': "เปิดการค้นหา",
  'Search(search dialog)': "ค้นหา",
  'Search(search trigger)': "ค้นหา",
} satisfies Translations;

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
  if (docsLocale === TH_TH_URL_LANG) return TH_FUMADOCS_TRANSLATIONS;
  if (docsLocale === MS_MY_URL_LANG) return MS_FUMADOCS_TRANSLATIONS;
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
