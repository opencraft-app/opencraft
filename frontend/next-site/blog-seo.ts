import type { Metadata } from 'next';

import { absolutePageUrlForSeoRegion, createPublicMetadata, seoRegion } from './seo';
import { blogCanonicalPath, getBlogPost, type BlogLocale, type BlogPost } from '@/pages/marketing/blog-content';

/** Advertise only the English and Chinese versions actually available. */
export function blogContentAlternates(post: BlogPost): Record<string, string> {
  const path = `/blog/${post.slug}`;
  const english = absolutePageUrlForSeoRegion('global', path);
  return {
    'x-default': english,
    'en-US': english,
    'zh-CN': absolutePageUrlForSeoRegion('cn', path),
    'zh-SG': absolutePageUrlForSeoRegion('global', `/zh-sg${path}`),
    'zh-Hant': absolutePageUrlForSeoRegion('global', `/zh-hant${path}`),
  };
}

export function blogArticleMetadata(source: BlogPost, locale?: BlogLocale): Metadata {
  const post = getBlogPost(source.slug, locale) ?? source;
  const path = blogCanonicalPath(post.slug, locale);
  const url = absolutePageUrlForSeoRegion(seoRegion(), path);
  const coverUrl = post.coverImage ? new URL(post.coverImage, url).href : undefined;
  const metadata = createPublicMetadata({
    path,
    title: post.title,
    description: post.excerpt,
    alternates: blogContentAlternates(post),
  });
  return {
    ...metadata,
    authors: [{ name: post.author }],
    alternates: { canonical: path, languages: blogContentAlternates(post) },
    openGraph: {
      ...metadata.openGraph,
      type: 'article',
      url,
      locale: post.language === 'zh-Hant' ? 'zh_TW' : post.language === 'zh-CN' ? 'zh_CN' : 'en_US',
      alternateLocale: ['en_US', 'zh_CN', 'zh_TW'].filter((language) => language !== (post.language === 'zh-Hant' ? 'zh_TW' : post.language === 'zh-CN' ? 'zh_CN' : 'en_US')),
      publishedTime: post.publishedAt,
      authors: [post.author],
      ...(coverUrl ? { images: [{ url: coverUrl, alt: post.title }] } : {}),
    },
    twitter: {
      ...metadata.twitter,
      ...(coverUrl ? { images: [coverUrl] } : {}),
    },
  };
}
