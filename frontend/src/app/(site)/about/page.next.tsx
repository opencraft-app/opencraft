import type { Metadata } from 'next';
import { PublicAboutPage } from '@next-site/public-pages';

export const metadata: Metadata = {
  title: '关于我们',
  description: 'LightVela 由腾讯轻量云团队出品，将 AI Agent 的完整能力搬上云端。',
};

export default function AboutPage() {
  return <PublicAboutPage />;
}
