import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PUBLIC_URL_LANGS, publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicChangelogPage } from '@next-site/public-pages';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return routeLocale.locale === 'en-US'
    ? {
        title: 'Changelog',
        description: 'Product updates, new capabilities, and experience improvements from LightVela.',
      }
    : {
        title: '更新日志',
        description: '记录 LightVela 的产品更新、能力上线与体验改进。',
      };
}

export default async function LocalizedChangelogPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicChangelogPage {...routeLocale} />;
}
