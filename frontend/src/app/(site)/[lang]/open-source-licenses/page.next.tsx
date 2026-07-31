import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicOpenSourceLicensesPage } from '@next-site/legal-pages';
import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Open Source Notices',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '開源聲明',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '开源声明',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '开源声明',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Attribution and license notices for open source software used by LightVela.',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela 使用的開源軟件歸屬與許可證聲明。',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela 使用的开源软件归属与许可证声明。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela 使用的开源软件归属与许可证声明。',
};

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
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
  });
}

export default async function LocalizedOpenSourceLicensesRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicOpenSourceLicensesPage {...routeLocale} />;
}
