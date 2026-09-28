import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Region-specific Blog metadata', () => {
  it.each(['global', 'cn'])('keeps canonical, language, cover and authors consistent for %s', async (region) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_REGION', region);
    vi.stubEnv('VITE_REGION', region);
    const { blogArticleMetadata, blogContentAlternates } = await import('./blog-seo');
    const { getBlogPosts } = await import('@/pages/marketing/blog-content');
    const domain = region === 'global' ? 'lightvela.ai' : 'lightvela.com';
    for (const post of getBlogPosts()) {
      const metadata = blogArticleMetadata(post);
      expect(metadata.title).toBe(post.title);
      expect(metadata.authors).toEqual([{ name: post.author }]);
      expect(metadata.alternates?.canonical).toBe(`/blog/${post.slug}`);
      expect(blogContentAlternates(post)).toEqual({
        'x-default': `https://lightvela.ai/blog/${post.slug}/`,
        'en-US': `https://lightvela.ai/blog/${post.slug}/`,
        'zh-CN': `https://lightvela.com/blog/${post.slug}/`,
        'zh-SG': `https://lightvela.ai/zh-sg/blog/${post.slug}/`,
        'zh-Hant': `https://lightvela.ai/zh-hant/blog/${post.slug}/`,
      });
      expect(metadata.openGraph).toMatchObject({
        type: 'article',
        url: `https://${domain}/blog/${post.slug}/`,
        locale: post.language === 'zh-CN' ? 'zh_CN' : 'en_US',
        alternateLocale: post.language === 'zh-CN' ? ['en_US', 'zh_TW'] : ['zh_CN', 'zh_TW'],
      });
      if (post.coverImage) expect(metadata.openGraph?.images).toEqual([
        { url: `https://${domain}${post.coverImage}`, alt: post.title },
      ]);
    }
  });
});

describe('Localized article metadata', () => {
  it.each(['en-US', 'zh-SG', 'zh-Hant', 'es'] as const)('matches the rendered %s article and canonical', async (locale) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_REGION', 'global');
    const { blogArticleMetadata } = await import('./blog-seo');
    const { BLOG_POSTS, getBlogPost, blogCanonicalPath } = await import('@/pages/marketing/blog-content');
    for (const source of BLOG_POSTS) {
      const post = getBlogPost(source.slug, locale)!;
      const metadata = blogArticleMetadata(post, locale);
      expect(metadata.title).toBe(post.title);
      expect(metadata.description).toBe(post.excerpt);
      expect(metadata.alternates?.canonical).toBe(blogCanonicalPath(post.slug, locale));
      expect(metadata.openGraph).toMatchObject({ locale: locale === 'zh-Hant' ? 'zh_TW' : locale === 'zh-SG' ? 'zh_CN' : 'en_US' });
    }
  });
});
