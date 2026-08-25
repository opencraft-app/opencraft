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
};

/**
 * 本站点需要生成「带语言前缀」文档路由的语言。
 *
 * ⚠️ **默认语言不在此列**，两站同理：
 * - 国内站唯一语言 zh-CN → 裸路径 `/docs/xxx/` 即正式 URL；
 * - 国际站默认语言 en-US → 裸路径 `/docs/xxx/` 即正式 URL。
 *
 * 过去两站都会为默认语言额外生成一整套前缀页面（返回 200），
 * 与裸路径构成重复内容。现改为不再生成，由 CDN 层 301 → 裸路径
 * （规则见 `scripts/write-edgeone-config.mjs`，说明见 `wiki/product-state/seo-url-migration.md`）。
 */
const REGION_DOCS_ROUTE_LOCALES = (
  isGlobal
    ? [PUBLIC_URL_LANGS.ZH_SG, PUBLIC_URL_LANGS.ZH_HANT, PUBLIC_URL_LANGS.ID_ID]
    : []
) as readonly DocsRouteLocale[];

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
  const locale = DOCS_LOCALE_TO_PUBLIC_LOCALE[contentLocale];

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
