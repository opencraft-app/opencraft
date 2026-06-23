import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicOpenSourceLicensesPage } from '@next-site/legal-pages';
import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/open-source-licenses', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: routeLocale.locale === 'en-US' ? 'Open Source Notices' : '开源声明',
    description:
      routeLocale.locale === 'en-US'
        ? 'Attribution and license notices for open source software used by LightVela.'
        : 'LightVela 使用的开源软件归属与许可证声明。',
  });
}

export default async function LocalizedOpenSourceLicensesRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicOpenSourceLicensesPage {...routeLocale} />;
}
