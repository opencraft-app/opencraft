import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PublicUrlLang } from '@next-site/public-locale';
import { SubscribePageClient } from '@next-site/subscribe-page-client';
import { createPublicMetadata, localizedPublicPath, prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';
import { japaneseRouteDescription, japaneseRouteTitle } from '@/lib/seo-data.ja';
import { koreanRouteDescription, koreanRouteTitle } from '@/lib/seo-data.ko';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Choose a Plan',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '选择套餐',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '选择套餐',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '選擇套餐',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Pilih Paket',
  [PUBLIC_SITE_LOCALES.ES]: 'Elige un plan',
  [PUBLIC_SITE_LOCALES.JA_JP]: japaneseRouteTitle('/subscribe'),
  [PUBLIC_SITE_LOCALES.KO_KR]: koreanRouteTitle('/subscribe'),
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Choose the LightVela plan that fits your Hermes Agent.',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '选择适合你的 LightVela 套餐。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '选择适合你的 LightVela 套餐。',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '選擇適合你的 LightVela 套餐。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Pilih paket LightVela yang sesuai untuk Hermes Agent Anda.',
  [PUBLIC_SITE_LOCALES.ES]: 'Elige el plan de LightVela que mejor se adapte a tu Hermes Agent.',
  [PUBLIC_SITE_LOCALES.JA_JP]: japaneseRouteDescription('/subscribe'),
  [PUBLIC_SITE_LOCALES.KO_KR]: koreanRouteDescription('/subscribe'),
};

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PREFIXED_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/subscribe', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    index: false,
  });
}

export default async function LocalizedSubscribePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return <SubscribePageClient {...routeLocale} />;
}
