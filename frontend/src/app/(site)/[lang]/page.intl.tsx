import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PublicUrlLang } from '@next-site/public-locale';
import { PublicHomePage } from '@next-site/public-pages';
import { createPublicMetadata, localizedPublicPath, prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS, SoftwareApplicationJsonLd } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES } from '@/lib/public-site-routing';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

// 首页元数据文案表：以 locale 常量为键，避免 `=== 'en-US'` 类魔法字符串。
const TITLE_BY_LOCALE: Record<PublicSiteLocale, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'LightVela | Your Personal Cloud AI Agent',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela｜云端专属个人 Agent',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela｜云端专属个人 Agent',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela｜雲端專屬個人 Agent',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'LightVela | Agen AI Pribadi di Cloud',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocale, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品。',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela 是騰訊輕量雲團隊推出的雲端 Agent 託管產品。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'LightVela adalah produk hosting Agent cloud dari tim Tencent Lighthouse.',
};

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PREFIXED_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/', lang as PublicUrlLang),
    locale: routeLocale.locale,
    // Record<PublicSiteLocale, string> 已在类型层保证 key 命中；
    // ?? EN_US 作运行时兜底，避免上游把 locale 拓宽为宽字符串时 Metadata 契约为 undefined。
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    /* 首页 title 已自带品牌名，跳过 root 模板，避免重复的 `| LightVela` 后缀 */
    titleAbsolute: true,
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
  });
}

export default async function LocalizedHomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return (
    <>
      <PublicHomePage {...routeLocale} />
      <SoftwareApplicationJsonLd locale={routeLocale.locale} />
    </>
  );
}
