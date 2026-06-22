import type { Metadata } from 'next';
import { PublicHomePage } from '@next-site/public-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';

export const metadata: Metadata = DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
  ? {
      title: 'LightVela · Your Personal Cloud AI Agent',
      description: 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.',
    }
  : {
      title: 'LightVela 云端专属个人 Agent',
      description: 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴。',
    };

export default function HomePage() {
  return <PublicHomePage />;
}
