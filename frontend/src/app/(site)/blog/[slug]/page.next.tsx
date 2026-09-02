import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { PublicBlogArticlePage } from '@next-site/public-pages';
import { buildGlobalEnglishContentAlternates, createPublicMetadata } from '@next-site/seo';
import { isGlobal } from '@/lib/region';
import { BLOG_POSTS, getBlogPost } from '@/pages/marketing/blog-content';

export function generateStaticParams(): { slug: string }[] {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!isGlobal || !post) notFound();

  return createPublicMetadata({
    path: `/blog/${slug}`,
    locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
    title: post.title,
    description: post.excerpt,
    alternates: buildGlobalEnglishContentAlternates(`/blog/${slug}`),
  });
}

export default async function BlogArticleRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isGlobal || !getBlogPost(slug)) notFound();

  return <PublicBlogArticlePage slug={slug} />;
}
