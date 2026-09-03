import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PublicUrlLang } from '@next-site/public-locale';
import { PublicBlogArticlePage } from '@next-site/public-pages';
import {
  buildGlobalEnglishContentAlternates,
  createPublicMetadata,
  localizedPublicPath,
  prefixedPublicRouteLocale,
  SEO_PREFIXED_PUBLIC_URL_LANGS,
} from '@next-site/seo';
import { isGlobal } from '@/lib/region';
import { BLOG_POSTS, getBlogPost } from '@/pages/marketing/blog-content';

export function generateStaticParams(): { lang: PublicUrlLang; slug: string }[] {
  return SEO_PREFIXED_PUBLIC_URL_LANGS.flatMap((lang) =>
    BLOG_POSTS.map((post) => ({ lang, slug: post.slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}): Promise<Metadata> {
  const { lang, slug } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  const post = getBlogPost(slug);
  if (!isGlobal || !routeLocale || !post) notFound();

  return createPublicMetadata({
    path: localizedPublicPath(`/blog/${slug}`, lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: post.title,
    description: post.excerpt,
    alternates: buildGlobalEnglishContentAlternates(`/blog/${slug}`),
  });
}

export default async function LocalizedBlogArticleRoute({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) {
  const { lang, slug } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!isGlobal || !routeLocale || !getBlogPost(slug)) notFound();

  return <PublicBlogArticlePage {...routeLocale} slug={slug} />;
}
