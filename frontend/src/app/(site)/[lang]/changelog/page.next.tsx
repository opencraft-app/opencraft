import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicChangelogPage } from '@next-site/public-pages';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';

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
    title:
      routeLocale.locale === 'en-US'
        ? 'Changelog'
        : routeLocale.locale === 'zh-Hant'
          ? '更新日誌'
          : '更新日志',
    description:
      routeLocale.locale === 'en-US'
        ? 'Product updates, new capabilities, and experience improvements from LightVela.'
        : routeLocale.locale === 'zh-Hant'
          ? '記錄 LightVela 的產品更新、能力上線與體驗改進。'
          : '记录 LightVela 的产品更新、能力上线与体验改进。',
  });
}

export default async function LocalizedChangelogPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicChangelogPage {...routeLocale} />;
}
