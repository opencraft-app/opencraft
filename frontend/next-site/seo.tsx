import type { Metadata } from 'next';
import React, { type ReactNode } from 'react';

import { isGlobal, type Region } from '@/lib/region';

import { DOCS_ROUTE_LOCALES, type DocsRouteLocale } from './docs-route-manifest';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import {
  DEFAULT_PUBLIC_ROUTE_LOCALE,
  PUBLIC_URL_LANGS,
  publicRouteLocaleFromLang,
  type PublicRouteLocale,
  type PublicUrlLang,
} from './public-locale';
import {
  EN_US_LOCALE,
  EN_US_URL_LANG,
  ES_LOCALE,
  ES_URL_LANG,
  ID_ID_LOCALE,
  ID_ID_URL_LANG,
  JA_JP_LOCALE,
  JA_JP_URL_LANG,
  KO_KR_LOCALE,
  KO_KR_URL_LANG,
  ZH_CN_URL_LANG,
  ZH_HANT_LOCALE,
  ZH_HANT_URL_LANG,
  ZH_SG_URL_LANG,
} from './public-locale';

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

/**
 * SEO 层用的站点区域。
 *
 * 刻意定义为 `Region` 的别名，而不是重复写一遍 `'cn' | 'global'`：
 * 两个独立定义的同值类型会在加第三个区域时静默分叉 ——
 * `PLAN_OFFERS_BY_SEO_REGION[seoRegion()]` 这类查表就会得到 undefined，
 * JSON-LD 静默缺字段（SEO 失效且不报错）。
 *
 * 用别名后 `Record<SeoSiteRegion, …>` 会在新增区域时**编译期**报缺 key，
 * 强制补齐配置。这比在访问处加可选链有效：可选链只是把静默 undefined
 * 包装得更「安全」，并不能让人知道漏配了。
 */
type SeoSiteRegion = Region;

const SITE_NAME = 'LightVela';
const DEFAULT_OG_IMAGE_PATH = '/lightvela-social-preview.png';
const BAIDU_SITE_VERIFICATION = 'codeva-ip0AdXURxG';
const WECHAT_SITE_VERIFICATION = 'pKLUCg80PuWPBYLB';
const DEFAULT_THEME_COLOR = '#f7f4ff';
const GLOBAL_ORGANIZATION_SAME_AS = [
  'https://discord.gg/Myh58xEMe2',
  'https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b',
  'https://x.com/agentlightvela',
  'https://www.youtube.com/@TencentLightVela',
] as const;
const GLOBAL_OFFICIAL_PROFILE_SAME_AS = [
  'https://x.com/agentlightvela',
  'https://www.youtube.com/@TencentLightVela',
] as const;

/**
 * 结构化数据用的套餐报价（schema.org AggregateOffer）。
 *
 * ⚠️ 价格事实来源：`wiki/product-state/geo-fact-table.md` 第 1.2 节（唯一来源＝订阅后台）。
 * 与 `next-site/subscribe-page.tsx` 的 STATIC_TIER_PRICE_YUAN / STATIC_AI_TIER_PRICE_YUAN
 * 必须保持一致；后端调价时三处需同步更新。
 *
 * 为何用 AggregateOffer 而非 Offer：国内站有 4 档套餐 × 月付/季付，单一 price 无法表达。
 * lowPrice 取最低月付首购价（启航首单免费＝0），highPrice 取最高月付原价（巡游 AI ¥158）。
 * 说明：lowPrice=0 表达的是「有免费试用入口」，与文档「首单免费体验 14 天」一致，
 * 不同于改造前把整个产品标成 price:'0' 的错误声明。
 *
 * 国际站计费状态本轮未确认（见事实表 1.1「国际站冻结」），沿用 $7.5 / $15 两档区间。
 */
const PLAN_OFFERS_BY_SEO_REGION: Record<SeoSiteRegion, Record<string, unknown>> = {
  cn: {
    '@type': 'AggregateOffer',
    priceCurrency: 'CNY',
    lowPrice: '0',
    highPrice: '158',
    offerCount: 4,
    availability: 'https://schema.org/InStock',
  },
  global: {
    '@type': 'AggregateOffer',
    priceCurrency: 'USD',
    lowPrice: '7.5',
    highPrice: '15',
    offerCount: 2,
    availability: 'https://schema.org/InStock',
  },
};

const LOCALE_TO_URL_LANG: Record<SeoLocale, PublicUrlLang> = {
  'en-US': 'en-us',
  'zh-CN': 'zh-cn',
  'zh-SG': 'zh-sg',
  'zh-Hant': 'zh-hant',
  'id-ID': 'id-id',
  es: 'es',
  'ja-JP': 'ja-jp',
  'ko-KR': 'ko-kr',
};

const URL_LANG_TO_LOCALE: Record<PublicUrlLang, SeoLocale> = {
  'en-us': 'en-US',
  'zh-cn': 'zh-CN',
  'zh-sg': 'zh-SG',
  'zh-hant': 'zh-Hant',
  'id-id': 'id-ID',
  es: 'es',
  'ja-jp': 'ja-JP',
  'ko-kr': 'ko-KR',
};

const LOCALE_TO_OG_LOCALE: Record<SeoLocale, string> = {
  'en-US': 'en_US',
  'zh-CN': 'zh_CN',
  'zh-SG': 'zh_SG',
  // OpenGraph 无 `zh_Hant` 泛区标准；繁体站采用香港用语（OpenCC cn→hk），故用 `zh_HK`。
  'zh-Hant': 'zh_HK',
  'id-ID': 'id_ID',
  es: 'es_ES',
  'ja-JP': 'ja_JP',
  'ko-KR': 'ko_KR',
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
    'Slack bot',
  ],
  'zh-CN': [
    'LightVela',
    '云端 Agent',
    '个人 Agent',
    'AI 伙伴',
    'Hermes Agent',
    'Agent 托管',
    '定时任务',
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
    'Slack bot',
  ],
  'zh-Hant': [
    'LightVela',
    '雲端 Agent',
    '個人 Agent',
    'AI 夥伴',
    'Hermes Agent',
    'Agent 託管',
    'Telegram bot',
    'WhatsApp bot',
    'Discord bot',
    'Slack bot',
  ],
  'id-ID': [
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
    'Slack bot',
  ],
  es: [
    'LightVela',
    'agente de IA en la nube',
    'agente de IA personal',
    'asistente de IA',
    'Hermes Agent',
    'alojamiento de agentes',
    'automatizaciones',
    'bot de Telegram',
    'bot de WhatsApp',
    'bot de Discord',
  ],
  // Hidden preparation locales are deliberately not part of any release array.
  'ja-JP': [
    'LightVela',
    'クラウドAIエージェント',
    'パーソナルAIエージェント',
    'AIアシスタント',
    'Hermes Agent',
    'AIエージェントホスティング',
    '自動化',
  ],
  'ko-KR': [
    'LightVela',
    '클라우드 AI 에이전트',
    '개인 AI 에이전트',
    'AI 어시스턴트',
    'Hermes Agent',
    'AI 에이전트 호스팅',
    '예약 작업',
    '스킬',
  ],
};

export const SOFTWARE_APPLICATION_DESCRIPTIONS: Record<SeoLocale, string> = {
  'en-US': 'LightVela is a cloud Agent hosting product for creating a long-term personal AI companion.',
  'zh-CN': 'LightVela 是云端 Agent 托管产品，用于创建长期在线、越聊越懂你的个人 AI 伙伴。',
  'zh-SG': 'LightVela 是云端 Agent 托管产品，用于创建长期在线、越聊越懂你的个人 AI 伙伴。',
  'zh-Hant': 'LightVela 是雲端 Agent 託管產品，用於建立長期在線、越聊越懂你的個人 AI 夥伴。',
  'id-ID': 'LightVela adalah produk hosting Agent berbasis cloud untuk membuat pendamping AI pribadi jangka panjang.',
  es: 'LightVela es una plataforma de agentes de IA en la nube para crear un asistente personal siempre disponible.',
  'ja-JP': 'LightVelaは、長期的に使える自分専用のAIアシスタントを作成するためのクラウドAIエージェント基盤です。',
  'ko-KR': 'LightVela는 장기간 사용할 수 있는 개인 AI 어시스턴트를 만드는 클라우드 AI 에이전트 플랫폼입니다.',
};

const GLOBAL_PUBLISHED_URL_LANGS = PUBLIC_URL_LANGS.filter((lang) => lang !== ZH_CN_URL_LANG);

/** 当前构建区域已通过语言注册表发布门禁的公开 URL 语言。 */
export const SEO_PUBLIC_URL_LANGS: readonly PublicUrlLang[] = isGlobal
  ? GLOBAL_PUBLISHED_URL_LANGS
  : PUBLIC_URL_LANGS.filter((lang) => lang === ZH_CN_URL_LANG);

function isDocsRouteLocale(lang: PublicUrlLang): lang is DocsRouteLocale {
  return (DOCS_ROUTE_LOCALES as readonly string[]).includes(lang);
}

/** 当前构建区域同时具备公开语言资格与文档路由清单的语言。 */
export const SEO_DOCS_ROUTE_LOCALES: readonly DocsRouteLocale[] =
  SEO_PUBLIC_URL_LANGS.filter(isDocsRouteLocale);

/** 跨国内站与国际站的完整已发布语言集合，供 hreflang 使用。 */
export const SEO_ALL_PUBLIC_URL_LANGS: readonly PublicUrlLang[] = [
  ...PUBLIC_URL_LANGS.filter((lang) => lang === ZH_CN_URL_LANG),
  ...GLOBAL_PUBLISHED_URL_LANGS,
];

/** 跨站点已发布且实际存在文档路由的语言集合。 */
export const SEO_ALL_DOCS_ROUTE_LOCALES: readonly DocsRouteLocale[] =
  SEO_ALL_PUBLIC_URL_LANGS.filter(isDocsRouteLocale);

/**
 * 需要生成「带语言前缀」静态路由的语言（用于 generateStaticParams）。
 *
 * 与 `SEO_PUBLIC_URL_LANGS` 的区别：后者表示「本站点支持哪些语言」，
 * 本常量表示「哪些语言需要额外的前缀 URL」。
 *
 * ⚠️ **默认语言不在此列**，两站同理：
 * - 国内站唯一语言 zh-CN → 裸路径即正式 URL，不生成 `/zh-cn/`；
 * - 国际站默认语言 en-US → 裸路径即正式 URL，不生成 `/en-us/`。
 *
 * 过去两站都会为默认语言额外生成一整套前缀路由（返回 200），造成：
 *   1. 与裸路径构成重复内容，分散权重；
 *   2. sitemap / hreflang 用裸路径，与实际存在的前缀路由并存，信号不一致；
 *   3. Google 需要自行判定主版本，索引结果不可控。
 * 现改为不再生成，配合 CDN 层 301 → 裸路径
 * （规则见 `scripts/write-edgeone-config.mjs`，说明见 `wiki/product-state/seo-url-migration.md`）。
 *
 * 国际站的非默认语言保持不变：`/zh-sg/`、`/zh-hant/`、`/id-id/` 均为真实语言版本。
 */
export const SEO_PREFIXED_PUBLIC_URL_LANGS: readonly PublicUrlLang[] =
  SEO_PUBLIC_URL_LANGS.filter((lang) => lang !== EN_US_URL_LANG && lang !== ZH_CN_URL_LANG);

/** 文档站版本，语义同 `SEO_PREFIXED_PUBLIC_URL_LANGS`。 */
export const SEO_PREFIXED_DOCS_ROUTE_LOCALES: readonly DocsRouteLocale[] =
  SEO_PREFIXED_PUBLIC_URL_LANGS.filter(isDocsRouteLocale);

/**
 * `[lang]` 路由的运行时守卫：只接受**本站点真的生成前缀路由**的语言。
 *
 * ⚠️ 不要直接用 `publicRouteLocaleFromLang()` —— 它基于全部 5 种语言，
 * 与 `generateStaticParams()` 用的 `SEO_PREFIXED_PUBLIC_URL_LANGS` 不是同一个集合。
 * 实测后果：`/en-us/about/` 在 dev 下返回 200（静态导出后其实是 404），
 * dev 与生产行为不一致，很容易误判「收敛没生效」。
 *
 * 用同一个常量派生守卫，两者不可能再漂移。
 */
export function prefixedPublicRouteLocale(lang: string): PublicRouteLocale | null {
  if (!(SEO_PREFIXED_PUBLIC_URL_LANGS as readonly string[]).includes(lang)) return null;
  return publicRouteLocaleFromLang(lang);
}

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
  if (locale === ES_LOCALE) return ES_URL_LANG;
  if (locale === JA_JP_LOCALE) return JA_JP_URL_LANG;
  if (locale === KO_KR_LOCALE) return KO_KR_URL_LANG;
  if (isGlobal && locale === ID_ID_LOCALE) return ID_ID_URL_LANG;
  if (isGlobal && locale === ZH_HANT_LOCALE) return ZH_HANT_URL_LANG;
  if (isGlobal && locale.startsWith('zh')) return ZH_SG_URL_LANG;
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
  if (isGlobal && locale === EN_US_URL_LANG) return localizedDocsPath('default', slug);
  return localizedDocsPath(locale, slug);
}

/**
 * 判断某个 URL-lang 在其所属站点上是否使用**裸路径**（无语言前缀）。
 *
 * - `en-us` → 国际站默认语言，`lightvela.ai/about/`
 * - `zh-cn` → 国内站唯一语言，`lightvela.com/about/`
 *
 * ⚠️ 关键：国内站（lightvela.com）**不存在 `/zh-cn/` 路由**。
 * `localizedPath()` 在 `!isGlobal` 时直接返回原路径，站内链接从不带前缀。
 * 若 hreflang / sitemap 里输出 `lightvela.com/zh-cn/...`，会指向 404 或需 301 的 URL，
 * Google 会因「hreflang 目标无效」丢弃整组语言关系。
 */
function usesBarePathForUrlLang(lang: PublicUrlLang): boolean {
  return lang === EN_US_URL_LANG || lang === ZH_CN_URL_LANG;
}

export function buildPublicAlternates(path: string): Record<string, string> {
  const publicPath = stripPublicLocalePrefix(path);
  const alternates: Record<string, string> = {
    'x-default': absolutePageUrlForSeoRegion('global', localizedPublicPath(publicPath, 'default')),
  };

  for (const lang of SEO_ALL_PUBLIC_URL_LANGS) {
    const locale = localeFromUrlLang(lang);
    const localizedPath = usesBarePathForUrlLang(lang) ? publicPath : localizedPublicPath(publicPath, lang);
    alternates[locale] = absolutePageUrlForUrlLang(lang, localizedPath);
  }

  return alternates;
}

/** Global-only public pages must not advertise a China-site hreflang target. */
export function buildGlobalPublicAlternates(path: string): Record<string, string> {
  const publicPath = stripPublicLocalePrefix(path);
  const alternates: Record<string, string> = {
    'x-default': absolutePageUrlForSeoRegion('global', localizedPublicPath(publicPath, 'default')),
  };

  for (const lang of SEO_PUBLIC_URL_LANGS) {
    const locale = localeFromUrlLang(lang);
    const localizedPath = usesBarePathForUrlLang(lang) ? publicPath : localizedPublicPath(publicPath, lang);
    alternates[locale] = absolutePageUrlForUrlLang(lang, localizedPath);
  }

  return alternates;
}

/** English-only content keeps localized UI routes without declaring untranslated content as another language. */
export function buildGlobalEnglishContentAlternates(path: string): Record<string, string> {
  const publicPath = stripPublicLocalePrefix(path);
  const englishUrl = absolutePageUrlForSeoRegion('global', localizedPublicPath(publicPath, 'default'));

  return {
    'x-default': englishUrl,
    'en-US': englishUrl,
  };
}

export function buildDocsAlternates(
  slug: readonly string[],
  availableLocales: readonly DocsRouteLocale[],
): Record<string, string> {
  const defaultLocale = availableLocales.includes(EN_US_URL_LANG)
    ? EN_US_URL_LANG
    : availableLocales.includes(ZH_SG_URL_LANG)
      ? ZH_SG_URL_LANG
      : availableLocales[0];
  const alternates: Record<string, string> = {};

  if (defaultLocale) {
    const defaultPath = usesBarePathForUrlLang(defaultLocale)
      ? localizedDocsPath('default', slug)
      : localizedDocsPath(defaultLocale, slug);
    alternates['x-default'] = absolutePageUrlForUrlLang(defaultLocale, defaultPath);
  }

  for (const locale of availableLocales) {
    const localizedPath = usesBarePathForUrlLang(locale)
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
  const sameAs = isGlobal ? GLOBAL_ORGANIZATION_SAME_AS : undefined;
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE_NAME,
      url,
      logo,
      ...(sameAs ? { sameAs: [...sameAs] } : {}),
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
        description: SOFTWARE_APPLICATION_DESCRIPTIONS[locale],
        offers: PLAN_OFFERS_BY_SEO_REGION[seoRegion()],
      }}
    />
  );
}

/**
 * Organization 实体声明（GEO/SEO）：AI 引擎与搜索引擎做品牌实体识别时依赖此结构化数据，
 * 建立产品与官方社媒主页的实体信任链。sameAs 只放指向品牌自身的档案页
 * （X / YouTube 官方主页），不放社区邀请链接与关联产品外链。
 * cn / global 构建均渲染；url / logo 由 siteUrl() 与 og 图按区域自动分叉。
 */
export function OrganizationJsonLd() {
  const sameAs = isGlobal ? GLOBAL_OFFICIAL_PROFILE_SAME_AS : undefined;

  return (
    <JsonLd
      id="lightvela-organization-jsonld"
      data={{
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: SITE_NAME,
        url: siteUrl(),
        logo: absoluteUrl(DEFAULT_OG_IMAGE_PATH),
        ...(sameAs ? { sameAs: [...sameAs] } : {}),
      }}
    />
  );
}

/**
 * WebSite 实体声明（GEO/SEO）：站点级身份锚点，与 hreflang 语言矩阵互补。
 * 站内暂无搜索功能，故不声明 SearchAction（避免向引擎声明不存在的功能）。
 */
export function WebSiteJsonLd() {
  return (
    <JsonLd
      id="lightvela-website-jsonld"
      data={{
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        url: siteUrl(),
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
  return React.createElement('script', {
    id,
    type: 'application/ld+json',
    dangerouslySetInnerHTML: {
      __html: JSON.stringify(data).replace(/</g, '\\u003c'),
    },
  });
}

export function absoluteUrl(path: string): string {
  return `${siteUrl()}${normalizePath(path) === '/' ? '' : normalizePath(path)}`;
}

export function absoluteUrlForSeoRegion(region: SeoSiteRegion, path: string): string {
  const normalizedPath = normalizePath(path);
  return `${siteUrlForSeoRegion(region)}${normalizedPath === '/' ? '' : normalizedPath}`;
}

export function absoluteUrlForUrlLang(lang: PublicUrlLang, path: string): string {
  return absoluteUrlForSeoRegion(lang === ZH_CN_URL_LANG ? 'cn' : 'global', path);
}

export function absolutePageUrlForSeoRegion(region: SeoSiteRegion, path: string): string {
  const normalizedPath = normalizePath(path);
  return `${siteOriginForSeoRegion(region)}${normalizedPath === '/' ? '/' : `${normalizedPath}/`}`;
}

export function absolutePageUrlForUrlLang(lang: PublicUrlLang, path: string): string {
  return absolutePageUrlForSeoRegion(lang === ZH_CN_URL_LANG ? 'cn' : 'global', path);
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
  // 从 PUBLIC_URL_LANGS 派生正则源，避免手写 `en-us|zh-cn|zh-sg|zh-hant` 与常量脱节。
  const prefixPattern = new RegExp(`^/(?:${SEO_ALL_PUBLIC_URL_LANGS.join('|')})(?=/|$)`);
  const barePath = normalizedPath.replace(prefixPattern, '');
  return barePath || '/';
}

function canonicalPathForLocale(path: string, locale: SeoLocale): string {
  if (isGlobal && locale === EN_US_LOCALE) return stripPublicLocalePrefix(path);
  return normalizePath(path);
}

function siteOriginForSeoRegion(region: SeoSiteRegion): string {
  return region === seoRegion() ? siteUrl() : siteUrlForSeoRegion(region);
}

function trimTrailingSlash(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}
