import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicCookiePolicyPage } from '@next-site/legal-pages';
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
    path: localizedPublicPath('/cookie-policy', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: routeLocale.locale === 'en-US' ? 'Cookies Policy' : 'Cookies 政策',
    description:
      routeLocale.locale === 'en-US'
        ? 'LightVela Cookies Policy, including cookie types, purposes, and controls.'
        : 'LightVela Cookies 政策，说明 cookies 的类型、用途和管理方式。',
  });
}

export default async function LocalizedCookiePolicyRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicCookiePolicyPage {...routeLocale} />;
}
