import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PUBLIC_URL_LANGS, publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicHomePage } from '@next-site/public-pages';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return routeLocale.locale === 'en-US'
    ? {
        title: 'LightVela · Your Personal Cloud AI Agent',
        description: 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.',
      }
    : {
        title: 'LightVela 云端专属个人 Agent',
        description: 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品。',
      };
}

export default async function LocalizedHomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicHomePage {...routeLocale} />;
}
