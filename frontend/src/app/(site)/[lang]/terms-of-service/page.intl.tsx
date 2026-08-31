import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicTermsOfServicePage } from '@next-site/legal-pages';
import { type PublicUrlLang } from '@next-site/public-locale';
import { createPublicMetadata, localizedPublicPath, prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';
import { japaneseRouteDescription, japaneseRouteTitle } from '@/lib/seo-data.ja';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Terms of Service',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '服務條款',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '服务条款',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '服务条款',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Ketentuan Layanan',
  [PUBLIC_SITE_LOCALES.ES]: 'Términos del servicio',
  [PUBLIC_SITE_LOCALES.JA_JP]: japaneseRouteTitle('/terms-of-service'),
  [PUBLIC_SITE_LOCALES.KO_KR]: 'Terms of Service',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'LightVela Terms of Service for accessing and using the LightVela service.',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela 服務條款，適用於訪問和使用 LightVela 服務。',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela 服务条款，适用于访问和使用 LightVela 服务。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela 服务条款，适用于访问和使用 LightVela 服务。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Ketentuan Layanan LightVela untuk mengakses dan menggunakan layanan LightVela.',
  [PUBLIC_SITE_LOCALES.ES]: 'Términos del servicio de LightVela aplicables al acceso y uso de la plataforma.',
  [PUBLIC_SITE_LOCALES.JA_JP]: japaneseRouteDescription('/terms-of-service'),
  [PUBLIC_SITE_LOCALES.KO_KR]: 'LightVela Terms of Service for accessing and using the LightVela service.',
};

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PREFIXED_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/terms-of-service', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
  });
}

export default async function LocalizedTermsOfServiceRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return <PublicTermsOfServicePage {...routeLocale} />;
}
