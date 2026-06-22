import type { Metadata } from 'next';
import { PublicChangelogPage } from '@next-site/public-pages';

export const metadata: Metadata = {
  title: '更新日志',
  description: '记录 LightVela 的产品更新、能力上线与体验改进。',
};

export default function ChangelogPage() {
  return <PublicChangelogPage />;
}
