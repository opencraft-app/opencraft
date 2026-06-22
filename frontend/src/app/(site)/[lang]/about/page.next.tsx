import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PUBLIC_URL_LANGS, publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicAboutPage } from '@next-site/public-pages';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return routeLocale.locale === 'en-US'
    ? {
        title: 'About LightVela',
        description: 'LightVela brings the cloud Agent experience to more people through a managed, approachable product.',
      }
    : {
        title: '关于我们',
        description: 'LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端。',
      };
}

export default async function LocalizedAboutPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicAboutPage {...routeLocale} />;
}
