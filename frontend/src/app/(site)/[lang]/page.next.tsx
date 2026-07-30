import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicHomePage } from '@next-site/public-pages';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS, SoftwareApplicationJsonLd } from '@next-site/seo';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title:
      routeLocale.locale === 'en-US'
        ? 'LightVela | Your Personal Cloud AI Agent'
        : 'LightVela｜云端专属个人 Agent',
    /* 首页 title 已自带品牌名，跳过 root 模板，避免重复的 `| LightVela` 后缀 */
    titleAbsolute: true,
    description:
      routeLocale.locale === 'en-US'
        ? 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.'
        : 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品。',
  });
}

export default async function LocalizedHomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return (
    <>
      <PublicHomePage {...routeLocale} />
      <SoftwareApplicationJsonLd locale={routeLocale.locale} />
    </>
  );
}
