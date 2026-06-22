import type { Metadata } from 'next';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { PublicAboutPage } from '@next-site/public-pages';

export const metadata: Metadata = DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
  ? {
      title: 'About Us',
      description: 'LightVela is built by the Tencent Lighthouse team to bring full Agent capability to the cloud.',
    }
  : {
      title: '关于我们',
      description: 'LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端。',
    };

export default function AboutPage() {
  return <PublicAboutPage />;
}
