import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PublicUrlLang } from '@next-site/public-locale';
import { PublicBlogPage } from '@next-site/public-pages';
import { buildGlobalPublicAlternates, createPublicMetadata, localizedPublicPath, prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS } from '@next-site/seo';
import { isGlobal } from '@/lib/region';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';
import { japaneseRouteDescription, japaneseRouteTitle } from '@/lib/seo-data.ja';
import { koreanRouteDescription, koreanRouteTitle } from '@/lib/seo-data.ko';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Blog',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '博客',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '博客',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '博客',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Blog',
  [PUBLIC_SITE_LOCALES.ES]: 'Blog',
  [PUBLIC_SITE_LOCALES.JA_JP]: japaneseRouteTitle('/blog'),
  [PUBLIC_SITE_LOCALES.KO_KR]: koreanRouteTitle('/blog'),
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'The LightVela Blog will share product announcements, updates, and use cases for cloud-hosted AI Agents.',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela 博客將分享雲端 AI Agent 的產品公告、更新和使用場景。',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela 博客将分享云端 AI Agent 的产品公告、更新和使用场景。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela 博客将分享云端 AI Agent 的产品公告、更新和使用场景。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Blog LightVela akan membagikan pengumuman produk, pembaruan, dan contoh penggunaan AI Agent yang dihosting di cloud.',
  [PUBLIC_SITE_LOCALES.ES]: 'El Blog de LightVela compartirá anuncios de producto, actualizaciones y casos de uso de agentes de IA alojados en la nube.',
  [PUBLIC_SITE_LOCALES.JA_JP]: japaneseRouteDescription('/blog'),
  [PUBLIC_SITE_LOCALES.KO_KR]: koreanRouteDescription('/blog'),
};

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PREFIXED_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!isGlobal || !routeLocale) notFound();

  return createPublicMetadata({
    path: localizedPublicPath('/blog', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    alternates: buildGlobalPublicAlternates('/blog'),
  });
}

export default async function LocalizedBlogRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!isGlobal || !routeLocale) notFound();

  return <PublicBlogPage {...routeLocale} />;
}
