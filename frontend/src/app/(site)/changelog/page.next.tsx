import type { Metadata } from 'next';
import { PublicChangelogPage } from '@next-site/public-pages';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/changelog',
  locale: 'zh-CN',
  title: '更新日志',
  description: '记录 LightVela 的产品更新、能力上线与体验改进。',
});

export default function ChangelogPage() {
  return <PublicChangelogPage />;
}
