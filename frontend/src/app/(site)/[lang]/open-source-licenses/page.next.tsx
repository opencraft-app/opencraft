import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicOpenSourceLicensesPage } from '@next-site/legal-pages';
import { PUBLIC_URL_LANGS, publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return routeLocale.locale === 'en-US'
    ? {
        title: 'Open Source Notices',
        description: 'Attribution and license notices for open source software used by LightVela.',
      }
    : {
        title: '开源声明',
        description: 'LightVela 使用的开源软件归属与许可证声明。',
      };
}

export default async function LocalizedOpenSourceLicensesRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicOpenSourceLicensesPage {...routeLocale} />;
}
