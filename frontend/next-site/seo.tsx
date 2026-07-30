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
  /**
   * 是否让页面 title 跳过 root layout 的 `%s | LightVela` 模板（用 `title.absolute`）。
   * 默认 false：title 走模板，追加 `| LightVela` 后缀。
   * 首页（home / landing）传 true：title 已自带品牌名（如「LightVela｜云端专属个人 Agent」），
   * 无需再追加后缀，避免出现「LightVela … | LightVela」的重复品牌名。
   */
  titleAbsolute?: boolean;
};

type SeoSiteRegion = 'cn' | 'global';

const SITE_NAME = 'LightVela';
const DEFAULT_OG_IMAGE_PATH = '/lightvela-logo.jpg';
const BAIDU_SITE_VERIFICATION = 'codeva-ip0AdXURxG';
const WECHAT_SITE_VERIFICATION = 'pKLUCg80PuWPBYLB';
const DEFAULT_THEME_COLOR = '#f7f4ff';

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
  if (envUrl) return trimTrailingSlash(envUrl);
  return siteUrlForSeoRegion(isGlobal ? 'global' : 'cn');
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

export function canonicalDocsPath(locale: DocsRouteLocale | 'default', slug: readonly string[]): string {
  if (isGlobal && locale === 'en-us') return localizedDocsPath('default', slug);
  return localizedDocsPath(locale, slug);
}

export function buildPublicAlternates(path: string): Record<string, string> {
  const publicPath = stripPublicLocalePrefix(path);
  const alternates: Record<string, string> = {
    'x-default': absolutePageUrlForSeoRegion('global', localizedPublicPath(publicPath, 'default')),
  };

  for (const lang of SEO_ALL_PUBLIC_URL_LANGS) {
    const locale = localeFromUrlLang(lang);
    const localizedPath = lang === 'en-us' ? publicPath : localizedPublicPath(publicPath, lang);
    alternates[locale] = absolutePageUrlForUrlLang(lang, localizedPath);
  }

  return alternates;
}

export function buildDocsAlternates(
  slug: readonly string[],
  availableLocales: readonly DocsRouteLocale[],
): Record<string, string> {
  const defaultLocale = availableLocales.includes('en-us')
    ? 'en-us'
    : availableLocales.includes('zh-sg')
      ? 'zh-sg'
      : availableLocales[0];
  const alternates: Record<string, string> = {};

  if (defaultLocale) {
    const defaultPath = defaultLocale === 'en-us'
      ? localizedDocsPath('default', slug)
      : localizedDocsPath(defaultLocale, slug);
    alternates['x-default'] = absolutePageUrlForUrlLang(defaultLocale, defaultPath);
  }

  for (const locale of availableLocales) {
    const localizedPath = locale === 'en-us'
      ? localizedDocsPath('default', slug)
      : localizedDocsPath(locale, slug);
    alternates[localeFromUrlLang(locale)] = absolutePageUrlForUrlLang(locale, localizedPath);
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
  titleAbsolute = false,
}: SeoPage): Metadata {
  const normalizedPath = normalizePath(path);
  const canonicalPath = canonicalPathForLocale(normalizedPath, locale);
  const canonical = absolutePageUrlForSeoRegion(isGlobal ? 'global' : 'cn', canonicalPath);
  const image = absoluteUrl(DEFAULT_OG_IMAGE_PATH);

  return {
    metadataBase: new URL(siteUrl()),
    /* titleAbsolute=true 时用 { absolute } 跳过 root layout 的 `%s | LightVela` 模板，
       让首页 title 保持自带品牌名、不追加后缀；其余页面仍走模板追加 `| LightVela`。
       openGraph / twitter 的 title 是独立纯字符串，不受模板影响，无需 absolute。 */
    title: titleAbsolute ? { absolute: title } : title,
    description,
    keywords: [...keywords],
    alternates: {
      canonical: canonicalPath,
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

export function absolutePageUrlForSeoRegion(region: SeoSiteRegion, path: string): string {
  const normalizedPath = normalizePath(path);
  return `${siteOriginForSeoRegion(region)}${normalizedPath === '/' ? '/' : `${normalizedPath}/`}`;
}

export function absolutePageUrlForUrlLang(lang: PublicUrlLang, path: string): string {
  return absolutePageUrlForSeoRegion(lang === 'zh-cn' ? 'cn' : 'global', path);
}

export function lastModified(): string | undefined {
  return process.env.NEXT_PUBLIC_BUILD_DATE || process.env.BUILD_DATE || undefined;
}

export function siteVerification() {
  const google =
    process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || process.env.GOOGLE_SITE_VERIFICATION || undefined;
  const yandex =
    process.env.NEXT_PUBLIC_YANDEX_SITE_VERIFICATION || process.env.YANDEX_SITE_VERIFICATION || undefined;

  return {
    ...(google ? { google } : {}),
    ...(yandex ? { yandex } : {}),
    other: {
      'baidu-site-verification': [BAIDU_SITE_VERIFICATION],
      'wechat-site-verification': [WECHAT_SITE_VERIFICATION],
    },
  };
}

export function themeColor(): string {
  return process.env.NEXT_PUBLIC_THEME_COLOR || DEFAULT_THEME_COLOR;
}

export function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  const withoutQuery = path.split(/[?#]/, 1)[0] || '/';
  const prefixed = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return trimTrailingSlash(prefixed) || '/';
}

function stripPublicLocalePrefix(path: string): string {
  const normalizedPath = normalizePath(path);
  const barePath = normalizedPath.replace(/^\/(?:en-us|zh-cn|zh-sg)(?=\/|$)/, '');
  return barePath || '/';
}

function canonicalPathForLocale(path: string, locale: SeoLocale): string {
  if (isGlobal && locale === 'en-US') return stripPublicLocalePrefix(path);
  return normalizePath(path);
}

function siteOriginForSeoRegion(region: SeoSiteRegion): string {
  return region === seoRegion() ? siteUrl() : siteUrlForSeoRegion(region);
}

function trimTrailingSlash(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}
