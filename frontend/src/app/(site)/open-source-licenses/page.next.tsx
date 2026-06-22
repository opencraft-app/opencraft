import type { Metadata } from 'next';

import { PublicOpenSourceLicensesPage } from '@next-site/legal-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';

export const metadata: Metadata = DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
  ? {
      title: 'Open Source Licenses',
      description: 'Open source software notices and license attributions used by LightVela.',
    }
  : {
      title: '开源声明',
      description: 'LightVela 使用的开源软件归属与许可证声明。',
    };

export default function OpenSourceLicensesRoute() {
  return <PublicOpenSourceLicensesPage />;
}
