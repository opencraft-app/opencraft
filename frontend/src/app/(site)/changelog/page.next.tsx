import type { Metadata } from 'next';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { PublicChangelogPage } from '@next-site/public-pages';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/changelog',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US' ? 'Changelog' : '更新日志',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'Product updates, new capabilities, and experience improvements from LightVela.'
      : '记录 LightVela 的产品更新、能力上线与体验改进。',
});

export default function ChangelogPage() {
  return <PublicChangelogPage />;
}
