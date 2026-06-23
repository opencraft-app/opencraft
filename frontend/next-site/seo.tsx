import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { isGlobal, type Region } from '@/lib/region';

import type { DocsRouteLocale } from './docs-route-manifest';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { DEFAULT_PUBLIC_ROUTE_LOCALE, type PublicUrlLang } from './public-locale';

export type SeoLocale = PublicSiteLocale;

type SeoPage = {
  title: string;
  description: string;
  path: string;
  locale?: SeoLocale;
  index?: boolean;
  alternates?: Record<string, string>;
  keywords?: readonly string[];
};

type SeoSiteRegion = 'cn' | 'global';

const SITE_NAME = 'LightVela';
const DEFAULT_OG_IMAGE_PATH = '/lightvela-logo.jpg';
const DEFAULT_LAST_MODIFIED = '2026-06-23';

const LOCALE_TO_URL_LANG: Record<SeoLocale, PublicUrlLang> = {
  'en-US': 'en-us',
  'zh-CN': 'zh-cn',
  'zh-SG': 'zh-sg',
};

const URL_LANG_TO_LOCALE: Record<PublicUrlLang, SeoLocale> = {
  'en-us': 'en-US',
  'zh-cn': 'zh-CN',
  'zh-sg': 'zh-SG',
};

const LOCALE_TO_OG_LOCALE: Record<SeoLocale, string> = {
  'en-US': 'en_US',
  'zh-CN': 'zh_CN',
  'zh-SG': 'zh_SG',
};

const DEFAULT_KEYWORDS: Record<SeoLocale, readonly string[]> = {
  'en-US': [
    'LightVela',
    'cloud AI agent',
    'personal AI agent',
    'AI companion',
    'Hermes Agent',
    'agent hosting',
    'automation',
    'Telegram bot',
    'WhatsApp bot',
    'Discord bot',
  ],
  'zh-CN': [
    'LightVela',
    '云端 Agent',
    '个人 Agent',
    'AI 伙伴',
    'Hermes Agent',
    'Agent 托管',
    '自动任务',
    '微信 Agent',
    'QQ 机器人',
  ],
  'zh-SG': [
    'LightVela',
    '云端 Agent',
    '个人 Agent',
    'AI 伙伴',
    'Hermes Agent',
    'Agent 托管',
    'Telegram bot',
    'WhatsApp bot',
    'Discord bot',
  ],
};

export const SEO_PUBLIC_URL_LANGS = (isGlobal ? ['en-us', 'zh-sg'] : ['zh-cn']) as readonly PublicUrlLang[];
export const SEO_DOCS_ROUTE_LOCALES = (isGlobal ? ['en-us', 'zh-sg'] : ['zh-cn']) as readonly DocsRouteLocale[];
export const SEO_ALL_PUBLIC_URL_LANGS = ['zh-cn', 'en-us', 'zh-sg'] as const satisfies readonly PublicUrlLang[];
export const SEO_ALL_DOCS_ROUTE_LOCALES = ['zh-cn', 'en-us', 'zh-sg'] as const satisfies readonly DocsRouteLocale[];

export function siteUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;
  return trimTrailingSlash(envUrl || 'https://lightvela.com');
}

export function siteUrlForSeoRegion(region: SeoSiteRegion): string {
  if (region === 'cn') {
    return trimTrailingSlash(process.env.NEXT_PUBLIC_CN_SITE_URL || process.env.CN_SITE_URL || 'https://lightvela.com');
  }

  return trimTrailingSlash(
    process.env.NEXT_PUBLIC_GLOBAL_SITE_URL ||
      process.env.NEXT_PUBLIC_INTL_SITE_URL ||
      process.env.GLOBAL_SITE_URL ||
      process.env.INTL_SITE_URL ||
      'https://lightvela.ai',
  );
}

export function seoRegion(): Region {
  return isGlobal ? 'global' : 'cn';
}

export function localeFromUrlLang(lang: PublicUrlLang): SeoLocale {
  return URL_LANG_TO_LOCALE[lang];
}

export function urlLangForLocale(locale: SeoLocale): PublicUrlLang {
  if (isGlobal && locale.startsWith('zh')) return 'zh-sg';
  return LOCALE_TO_URL_LANG[locale];
}

export function localizedPublicPath(path: string, lang: PublicUrlLang | 'default'): string {
  const normalized = normalizePath(path);
  if (lang === 'default') return normalized;
  if (normalized === '/') return `/${lang}`;
  return `/${lang}${normalized}`;
}

export function localizedDocsPath(locale: DocsRouteLocale | 'default', slug: readonly string[]): string {
  const suffix = slug.length > 0 ? `/${slug.join('/')}` : '';
  if (locale === 'default') return `/docs${suffix}`;
  return `/${locale}/docs${suffix}`;
}

export function buildPublicAlternates(path: string): Record<string, string> {
  const alternates: Record<string, string> = {
    'x-default': absoluteUrlForSeoRegion('global', localizedPublicPath(path, 'default')),
  };

  for (const lang of SEO_ALL_PUBLIC_URL_LANGS) {
    const locale = localeFromUrlLang(lang);
    alternates[locale] = absoluteUrlForUrlLang(lang, localizedPublicPath(path, lang));
  }

  return alternates;
}

export function buildDocsAlternates(
  slug: readonly string[],
  availableLocales: readonly DocsRouteLocale[],
): Record<string, string> {
  const alternates: Record<string, string> = {
    'x-default': absoluteUrlForSeoRegion('global', localizedDocsPath('default', slug)),
  };

  for (const locale of availableLocales) {
    alternates[localeFromUrlLang(locale)] = absoluteUrlForUrlLang(locale, localizedDocsPath(locale, slug));
  }

  return alternates;
}

export function createPublicMetadata({
  title,
  description,
  path,
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  index = true,
  alternates = buildPublicAlternates(path),
  keywords = DEFAULT_KEYWORDS[locale],
}: SeoPage): Metadata {
  const normalizedPath = normalizePath(path);
  const canonical = absoluteUrl(normalizedPath);
  const image = absoluteUrl(DEFAULT_OG_IMAGE_PATH);

  return {
    metadataBase: new URL(siteUrl()),
    title,
    description,
    keywords: [...keywords],
    alternates: {
      canonical: normalizedPath,
      languages: alternates,
    },
    robots: index
      ? { index: true, follow: true }
      : { index: false, follow: false, googleBot: { index: false, follow: false } },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      url: canonical,
      locale: LOCALE_TO_OG_LOCALE[locale],
      alternateLocale: Object.keys(alternates)
        .filter((key) => key !== 'x-default' && key !== locale)
        .map((key) => LOCALE_TO_OG_LOCALE[key as SeoLocale])
        .filter(Boolean),
      images: [{ url: image, alt: SITE_NAME }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}

export function SiteJsonLd() {
  const url = siteUrl();
  const logo = absoluteUrl('/lightvela-logo.jpg');
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE_NAME,
      url,
      logo,
      sameAs: [
        'https://discord.com/invite/NDqtU3JQTc',
        'https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b',
        'https://x.com/agentlightvela',
        'https://www.youtube.com/@TencentLightVela',
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url,
      inLanguage: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
    },
  ];

  return <JsonLd id="lightvela-site-jsonld" data={data} />;
}

export function SoftwareApplicationJsonLd({ locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale }: { locale?: SeoLocale }) {
  const isEnglish = locale === 'en-US';
  return (
    <JsonLd
      id="lightvela-software-jsonld"
      data={{
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        url: siteUrl(),
        image: absoluteUrl(DEFAULT_OG_IMAGE_PATH),
        description: isEnglish
          ? 'LightVela is a cloud Agent hosting product for creating a long-term personal AI companion.'
          : 'LightVela 是云端 Agent 托管产品，用于创建长期在线、越聊越懂你的个人 AI 伙伴。',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: isEnglish ? 'USD' : 'CNY',
          availability: 'https://schema.org/InStock',
        },
      }}
    />
  );
}

export function BreadcrumbJsonLd({ items }: { items: readonly { name: string; path: string }[] }) {
  return (
    <JsonLd
      id="lightvela-breadcrumb-jsonld"
      data={{
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((item, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: item.name,
          item: absoluteUrl(item.path),
        })),
      }}
    />
  );
}

function JsonLd({ id, data }: { id: string; data: unknown }): ReactNode {
  return (
    <script
      id={id}
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, '\\u003c'),
      }}
    />
  );
}

export function absoluteUrl(path: string): string {
  return `${siteUrl()}${normalizePath(path) === '/' ? '' : normalizePath(path)}`;
}

export function absoluteUrlForSeoRegion(region: SeoSiteRegion, path: string): string {
  const normalizedPath = normalizePath(path);
  return `${siteUrlForSeoRegion(region)}${normalizedPath === '/' ? '' : normalizedPath}`;
}

export function absoluteUrlForUrlLang(lang: PublicUrlLang, path: string): string {
  return absoluteUrlForSeoRegion(lang === 'zh-cn' ? 'cn' : 'global', path);
}

export function lastModified(): string {
  return process.env.NEXT_PUBLIC_BUILD_DATE || process.env.BUILD_DATE || DEFAULT_LAST_MODIFIED;
}

export function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  const withoutQuery = path.split(/[?#]/, 1)[0] || '/';
  const prefixed = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return trimTrailingSlash(prefixed) || '/';
}

function trimTrailingSlash(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}
