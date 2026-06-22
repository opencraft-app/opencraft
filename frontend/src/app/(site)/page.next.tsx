import type { Metadata } from 'next';
import { PublicHomePage } from '@next-site/public-pages';

export const metadata: Metadata = {
  title: 'LightVela 云端专属个人 Agent',
  description: 'LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴。',
};

export default function HomePage() {
  return <PublicHomePage />;
}
