import type { Metadata } from 'next';
import { InternationalHomePage } from '@next-site/international-home-page';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { createPublicMetadata, OrganizationJsonLd, SoftwareApplicationJsonLd, WebSiteJsonLd } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela | Your Personal Cloud AI Agent'
      : 'LightVela｜长期在线的云端 AI 伙伴',
  /* 首页 title 已自带品牌名，跳过 root 模板，避免重复的 `| LightVela` 后缀 */
  titleAbsolute: true,
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.'
      : 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，让你在微信、QQ、企业微信、飞书等国内常用入口拥有长期在线的 Hermes Agent。',
});

export default function HomePage() {
  return (
    <>
      <InternationalHomePage locale={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} />
      <SoftwareApplicationJsonLd locale={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} />
      <OrganizationJsonLd />
      <WebSiteJsonLd />
    </>
  );
}
