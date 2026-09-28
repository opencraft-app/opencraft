import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { PublicBlogArticlePage } from '@next-site/public-pages';
import { blogArticleMetadata } from '@next-site/blog-seo';
import { BLOG_POSTS, getBlogPost } from '@/pages/marketing/blog-content';

export function generateStaticParams(): { slug: string }[] {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug, DEFAULT_PUBLIC_ROUTE_LOCALE.locale);
  if (!post) notFound();

  return blogArticleMetadata(post);
}

export default async function BlogArticleRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!getBlogPost(slug, DEFAULT_PUBLIC_ROUTE_LOCALE.locale)) notFound();

  return <PublicBlogArticlePage slug={slug} />;
}
