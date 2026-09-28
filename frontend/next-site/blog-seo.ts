import type { Metadata } from 'next';

import { absolutePageUrlForSeoRegion, createPublicMetadata, seoRegion } from './seo';
import { localeDefinition, publishedLocaleDefinitions } from '@/i18n/locales.config';
import { blogArticleLocale, blogCanonicalPath, getBlogPost, type BlogLocale, type BlogPost } from '@/pages/marketing/blog-content';

/** Every published international locale has a complete article translation. */
export function blogContentAlternates(post: BlogPost): Record<string, string> {
  const path = `/blog/${post.slug}`;
  return {
    'x-default': absolutePageUrlForSeoRegion('global', path),
    ...Object.fromEntries(publishedLocaleDefinitions().filter(({ code }) => code !== 'zh-CN').map(({ code, urlLang }) => [
      code,
      absolutePageUrlForSeoRegion('global', code === 'en-US' ? path : `/${urlLang}${path}`),
    ])),
    'zh-CN': absolutePageUrlForSeoRegion('cn', path),
  };
}

export function blogArticleMetadata(source: BlogPost, locale?: BlogLocale): Metadata {
  const post = getBlogPost(source.slug, locale) ?? source;
  const path = blogCanonicalPath(post.slug, locale);
  const url = absolutePageUrlForSeoRegion(seoRegion(), path);
  const coverUrl = post.coverImage ? new URL(post.coverImage, url).href : undefined;
  const ogLocale = localeDefinition(blogArticleLocale(locale)).ogLocale;
  const alternateLocales = Object.keys(blogContentAlternates(post))
    .filter((language) => language !== 'x-default')
    .map((language) => localeDefinition(language as BlogLocale).ogLocale)
    .filter((language) => language !== ogLocale);
  const metadata = createPublicMetadata({
    path,
    locale: blogArticleLocale(locale),
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
      locale: ogLocale,
      alternateLocale: alternateLocales,
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
