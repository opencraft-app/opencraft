/**
 * 多语言 /:lang/blog/[slug] 文章详情路由。
 * SSG：全语言 × 全文章的笛卡尔积。
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicBlogArticlePage } from '@next-site/public-pages';
import {
  createPublicMetadata,
  localizedPublicPath,
  SEO_ALL_PUBLIC_URL_LANGS,
} from '@next-site/seo';
import {
  getBlogArticleBySlug,
  listBlogArticleSlugs,
  pickBlogText,
} from '@/pages/marketing/blog-content';

export function generateStaticParams(): { lang: PublicUrlLang; slug: string }[] {
  const slugs = listBlogArticleSlugs();
  return SEO_ALL_PUBLIC_URL_LANGS.flatMap((lang) => slugs.map((slug) => ({ lang, slug })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}): Promise<Metadata> {
  const { lang, slug } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  const article = getBlogArticleBySlug(slug);
  if (!article) notFound();
  return createPublicMetadata({
    path: localizedPublicPath(`/blog/${slug}`, lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: pickBlogText(article.title, routeLocale.locale),
    description: pickBlogText(article.summary, routeLocale.locale),
  });
}

export default async function LocalizedBlogArticleRoute({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) {
  const { lang, slug } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  const article = getBlogArticleBySlug(slug);
  if (!article) notFound();
  return <PublicBlogArticlePage {...routeLocale} slug={slug} />;
}
