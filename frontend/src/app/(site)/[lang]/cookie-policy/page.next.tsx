import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicCookiePolicyPage } from '@next-site/legal-pages';
import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Cookies Policy',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'Cookies 政策',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'Cookies 政策',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'Cookies 政策',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Kebijakan Cookies',
  [PUBLIC_SITE_LOCALES.ES]: 'Política de cookies',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'Cookies Policy',
  [PUBLIC_SITE_LOCALES.KO_KR]: 'Cookies Policy',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'LightVela Cookies Policy, including cookie types, purposes, and controls.',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela Cookies 政策，說明 cookies 的類型、用途和管理方式。',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela Cookies 政策，说明 cookies 的类型、用途和管理方式。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela Cookies 政策，说明 cookies 的类型、用途和管理方式。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Kebijakan Cookies LightVela, termasuk jenis, tujuan, dan kontrol cookies.',
  [PUBLIC_SITE_LOCALES.ES]: 'Política de cookies de LightVela, incluidos sus tipos, finalidades y opciones de control.',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'LightVela Cookies Policy, including cookie types, purposes, and controls.',
  [PUBLIC_SITE_LOCALES.KO_KR]: 'LightVela Cookies Policy, including cookie types, purposes, and controls.',
};

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
    // Record<PublicSiteLocaleCode, string> + PublicSiteLocaleCode 联合类型
    // 已经在类型层保证 key 存在；?? 兜底仅作运行时防御（若 routeLocale.locale
    // 被上游改造成更宽的字符串类型，避免返回 undefined 破坏 Metadata 契约）。
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
  });
}

export default async function LocalizedCookiePolicyRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicCookiePolicyPage {...routeLocale} />;
}
