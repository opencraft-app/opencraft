import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicAboutPage } from '@next-site/public-pages';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES } from '@/lib/public-site-routing';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

// 关于页元数据文案表：与首页保持相同「按 locale key 查表 + EN_US 兜底」模式。
const TITLE_BY_LOCALE: Record<PublicSiteLocale, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'About LightVela',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '关于我们',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '关于我们',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '關於我們',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Tentang LightVela',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocale, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]:
    'LightVela brings the cloud Agent experience to more people through a managed, approachable product.',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端。',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela 由騰訊輕量雲團隊出品，將 AI Agent 的完整能力搬上雲端。',
  [PUBLIC_SITE_LOCALES.ID_ID]:
    'LightVela menghadirkan pengalaman Agent cloud yang terkelola dan mudah digunakan untuk lebih banyak orang.',
};

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
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
  });
}

export default async function LocalizedAboutPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicAboutPage {...routeLocale} />;
}
