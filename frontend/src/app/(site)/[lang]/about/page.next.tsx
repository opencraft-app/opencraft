import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicAboutPage } from '@next-site/public-pages';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/about', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: routeLocale.locale === 'en-US' ? 'About LightVela' : '关于我们',
    description:
      routeLocale.locale === 'en-US'
        ? 'LightVela brings the cloud Agent experience to more people through a managed, approachable product.'
        : 'LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端。',
  });
}

export default async function LocalizedAboutPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicAboutPage {...routeLocale} />;
}
