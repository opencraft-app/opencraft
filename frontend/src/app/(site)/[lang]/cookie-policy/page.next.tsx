import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicCookiePolicyPage } from '@next-site/legal-pages';
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
        title: 'Cookies Policy',
        description: 'LightVela Cookies Policy, including cookie types, purposes, and controls.',
      }
    : {
        title: 'Cookies 政策',
        description: 'LightVela Cookies 政策，说明 cookies 的类型、用途和管理方式。',
      };
}

export default async function LocalizedCookiePolicyRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicCookiePolicyPage {...routeLocale} />;
}
