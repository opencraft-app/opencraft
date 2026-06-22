import { docsMetadata, LightVelaDocsPage } from '@next-site/docs-page';
import { DEFAULT_PUBLIC_DOCS_LOCALE, DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { LightVelaDocsHeader } from '@next-site/docs-header';
import { LightVelaDocsLayout } from '@next-site/docs-layout';
import { PublicSiteLocaleBridge } from '@next-site/public-site-providers';
import { DOCS_ROUTE_SLUGS, isDocsRouteSlug } from '@next-site/docs-route-manifest';
import { notFound } from 'next/navigation';

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  if (!isDocsRouteSlug(DEFAULT_PUBLIC_DOCS_LOCALE, slug)) notFound();

  return (
    <PublicSiteLocaleBridge locale={DEFAULT_PUBLIC_ROUTE_LOCALE.locale}>
      <LightVelaDocsHeader {...DEFAULT_PUBLIC_ROUTE_LOCALE} />
      <LightVelaDocsLayout contentLocale={DEFAULT_PUBLIC_DOCS_LOCALE}>
        <LightVelaDocsPage prefix={DEFAULT_PUBLIC_DOCS_LOCALE} slug={slug} />
      </LightVelaDocsLayout>
    </PublicSiteLocaleBridge>
  );
}

export function generateStaticParams() {
  return DOCS_ROUTE_SLUGS[DEFAULT_PUBLIC_DOCS_LOCALE].map((slug) => ({ slug: [...slug] }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  if (!isDocsRouteSlug(DEFAULT_PUBLIC_DOCS_LOCALE, slug)) notFound();
  return docsMetadata(DEFAULT_PUBLIC_DOCS_LOCALE, slug);
}
