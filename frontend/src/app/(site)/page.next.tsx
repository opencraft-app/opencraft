import type { Metadata } from 'next';
import { InternationalHomePage } from '@next-site/international-home-page';
import { shouldUseInternationalV2Home } from '@next-site/international-home-routing';
import { PublicHomePage } from '@next-site/public-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { createPublicMetadata, OrganizationJsonLd, SoftwareApplicationJsonLd, WebSiteJsonLd } from '@next-site/seo';
import { isGlobal } from '@/lib/region';

export const metadata: Metadata = createPublicMetadata({
  path: '/',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela | Your Personal Cloud AI Agent'
      : 'LightVela｜云端专属个人 Agent',
  /* 首页 title 已自带品牌名，跳过 root 模板，避免重复的 `| LightVela` 后缀 */
  titleAbsolute: true,
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.'
      : 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴。',
});

export default function HomePage() {
  const useInternationalV2Home = shouldUseInternationalV2Home(isGlobal, DEFAULT_PUBLIC_ROUTE_LOCALE.locale);
  return (
    <>
      {useInternationalV2Home ? <InternationalHomePage locale={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} /> : <PublicHomePage />}
      <SoftwareApplicationJsonLd locale={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} />
      <OrganizationJsonLd />
      <WebSiteJsonLd />
    </>
  );
}
