import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicChangelogPage } from '@next-site/public-pages';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';

/**
 * 每个公开 locale 对应的 SEO 标题 / 描述。
 * 用 Record 显式列出全部四种 locale，避免嵌套三元 & 魔法字符串，
 * TypeScript 会保证 `PublicSiteLocaleCode` 联合类型的完备覆盖。
 */
const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Changelog',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '更新日誌',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '更新日志',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '更新日志',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Catatan Rilis',
  [PUBLIC_SITE_LOCALES.ES]: 'Novedades',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'Changelog',
  [PUBLIC_SITE_LOCALES.KO_KR]: 'Changelog',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Product updates, new capabilities, and experience improvements from LightVela.',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '記錄 LightVela 的產品更新、能力上線與體驗改進。',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '记录 LightVela 的产品更新、能力上线与体验改进。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '记录 LightVela 的产品更新、能力上线与体验改进。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Pembaruan produk, kemampuan baru, dan peningkatan pengalaman dari LightVela.',
  [PUBLIC_SITE_LOCALES.ES]: 'Consulta las actualizaciones del producto, las nuevas funciones y las mejoras de experiencia de LightVela.',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'Product updates, new capabilities, and experience improvements from LightVela.',
  [PUBLIC_SITE_LOCALES.KO_KR]: 'Product updates, new capabilities, and experience improvements from LightVela.',
};

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/changelog', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
  });
}

export default async function LocalizedChangelogPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicChangelogPage {...routeLocale} />;
}
