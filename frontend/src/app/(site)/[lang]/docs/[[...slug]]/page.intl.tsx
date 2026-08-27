import { notFound } from 'next/navigation';

import { docsMetadata, LightVelaDocsPage, type DocsLocalePrefix } from '@next-site/docs-page';
import { LightVelaDocsLayout } from '@next-site/docs-layout';
import {
  DOCS_ROUTE_LOCALES,
  DOCS_ROUTE_SLUGS,
  isDocsRouteSlug,
  type DocsRouteLocale,
} from '@next-site/docs-route-manifest';
import { LightVelaDocsHeader } from '@next-site/docs-header';
import { PublicSiteLocaleBridge } from '@next-site/public-site-providers';
import { isGlobal } from '@/lib/region';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { PUBLIC_SITE_LOCALES, PUBLIC_URL_LANGS } from '@/lib/public-site-routing';

const DOCS_LOCALE_TO_PUBLIC_LOCALE: Record<DocsRouteLocale, PublicSiteLocale> = {
  [PUBLIC_URL_LANGS.EN_US]: PUBLIC_SITE_LOCALES.EN_US,
  [PUBLIC_URL_LANGS.ZH_CN]: PUBLIC_SITE_LOCALES.ZH_CN,
  [PUBLIC_URL_LANGS.ZH_SG]: PUBLIC_SITE_LOCALES.ZH_SG,
  [PUBLIC_URL_LANGS.ZH_HANT]: PUBLIC_SITE_LOCALES.ZH_HANT,
  [PUBLIC_URL_LANGS.ID_ID]: PUBLIC_SITE_LOCALES.ID_ID,
  [PUBLIC_URL_LANGS.ES]: PUBLIC_SITE_LOCALES.ES,
};

/**
 * 默认语言不生成带前缀的重复页面：国内站 zh-CN、国际站 en-US 均使用裸 `/docs`。
 * 国际站其余已发布语言保留带语言前缀的正式路由。
 */
const GLOBAL_DOCS_ROUTE_LOCALES = [
  PUBLIC_URL_LANGS.ZH_SG,
  PUBLIC_URL_LANGS.ZH_HANT,
  PUBLIC_URL_LANGS.ID_ID,
  PUBLIC_URL_LANGS.ES,
] as const satisfies readonly DocsRouteLocale[];

const CN_DOCS_ROUTE_LOCALES = [] as const satisfies readonly DocsRouteLocale[];

export function docsRouteLocalesForRegion(region: 'cn' | 'global'): readonly DocsRouteLocale[] {
  return region === 'global' ? GLOBAL_DOCS_ROUTE_LOCALES : CN_DOCS_ROUTE_LOCALES;
}

export function publicLocaleForDocsRoute(locale: DocsRouteLocale): PublicSiteLocale {
  return DOCS_LOCALE_TO_PUBLIC_LOCALE[locale];
}

const REGION_DOCS_ROUTE_LOCALES = docsRouteLocalesForRegion(isGlobal ? 'global' : 'cn');

function docsRouteLocale(lang: string): DocsRouteLocale {
  if ((REGION_DOCS_ROUTE_LOCALES as readonly string[]).includes(lang)) return lang as DocsRouteLocale;
  notFound();
}

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string; slug?: string[] }>;
}) {
  const { lang, slug } = await params;
  const contentLocale = docsRouteLocale(lang);
  if (!isDocsRouteSlug(contentLocale, slug)) notFound();
  const locale = publicLocaleForDocsRoute(contentLocale);

  return (
    <PublicSiteLocaleBridge locale={locale}>
      <LightVelaDocsHeader locale={locale} localized />
      <LightVelaDocsLayout contentLocale={contentLocale}>
        <LightVelaDocsPage prefix={contentLocale} slug={slug} />
      </LightVelaDocsLayout>
    </PublicSiteLocaleBridge>
  );
}

export function generateStaticParams() {
  return DOCS_ROUTE_LOCALES.filter((lang) => REGION_DOCS_ROUTE_LOCALES.includes(lang)).flatMap((lang) =>
    DOCS_ROUTE_SLUGS[lang].map((slug) => ({ lang, slug: [...slug] })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; slug?: string[] }>;
}) {
  const { lang, slug } = await params;
  const contentLocale = docsRouteLocale(lang);
  if (!isDocsRouteSlug(contentLocale, slug)) notFound();
  return docsMetadata(contentLocale as DocsLocalePrefix, slug);
}
