import type { Metadata } from 'next';

import { PublicOpenSourceLicensesPage } from '@next-site/legal-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/open-source-licenses',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US' ? 'Open Source Notice' : '开源声明',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'Open source software notices and license attributions used by LightVela.'
      : 'LightVela 使用的开源软件归属与许可证声明。',
});

export default function OpenSourceLicensesRoute() {
  return <PublicOpenSourceLicensesPage />;
}
