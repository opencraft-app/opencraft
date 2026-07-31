/**
 * 默认 locale 的 /blog/[slug] 文章详情路由。
 * SSG：通过 generateStaticParams 枚举全部文章 slug。
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { PublicBlogArticlePage } from '@next-site/public-pages';
import { createPublicMetadata } from '@next-site/seo';
import {
  getBlogArticleBySlug,
  listBlogArticleSlugs,
  pickBlogText,
} from '@/pages/marketing/blog-content';

export function generateStaticParams(): { slug: string }[] {
  return listBlogArticleSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getBlogArticleBySlug(slug);
  if (!article) notFound();

  const locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale;
  return createPublicMetadata({
    path: `/blog/${slug}`,
    locale,
    title: pickBlogText(article.title, locale),
    description: pickBlogText(article.summary, locale),
  });
}

export default async function BlogArticleRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = getBlogArticleBySlug(slug);
  if (!article) notFound();
  return <PublicBlogArticlePage slug={slug} />;
}
