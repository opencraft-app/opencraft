import type { Metadata } from 'next';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { PublicAboutPage } from '@next-site/public-pages';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/about',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US' ? 'About Us' : '关于我们',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela is built by the Tencent Lighthouse team to bring full Agent capability to the cloud.'
      : 'LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端。',
});

export default function AboutPage() {
  return <PublicAboutPage />;
}
