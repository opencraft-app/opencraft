import type { Metadata } from 'next';
import { PublicHomePage } from '@next-site/public-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { createPublicMetadata, SoftwareApplicationJsonLd } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela · Your Personal Cloud AI Agent'
      : 'LightVela 云端专属个人 Agent',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.'
      : 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴。',
});

export default function HomePage() {
  return (
    <>
      <PublicHomePage />
      <SoftwareApplicationJsonLd locale={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} />
    </>
  );
}
