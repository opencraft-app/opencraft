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
import { docsRouteLocalesForRegion } from '@next-site/docs-route-publication';
import { PublicSiteLocaleBridge } from '@next-site/public-site-providers';
import { isGlobal } from '@/lib/region';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { PUBLIC_SITE_LOCALES, PUBLIC_URL_LANGS } from '@/lib/public-site-routing';

export { docsRouteLocalesForRegion } from '@next-site/docs-route-publication';

const DOCS_LOCALE_TO_PUBLIC_LOCALE: Record<DocsRouteLocale, PublicSiteLocale> = {
  [PUBLIC_URL_LANGS.EN_US]: PUBLIC_SITE_LOCALES.EN_US,
  [PUBLIC_URL_LANGS.ZH_CN]: PUBLIC_SITE_LOCALES.ZH_CN,
  [PUBLIC_URL_LANGS.ZH_SG]: PUBLIC_SITE_LOCALES.ZH_SG,
  [PUBLIC_URL_LANGS.ZH_HANT]: PUBLIC_SITE_LOCALES.ZH_HANT,
  [PUBLIC_URL_LANGS.ID_ID]: PUBLIC_SITE_LOCALES.ID_ID,
  [PUBLIC_URL_LANGS.ES]: PUBLIC_SITE_LOCALES.ES,
  [PUBLIC_URL_LANGS.JA_JP]: PUBLIC_SITE_LOCALES.JA_JP,
  [PUBLIC_URL_LANGS.KO_KR]: PUBLIC_SITE_LOCALES.KO_KR,
};

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
