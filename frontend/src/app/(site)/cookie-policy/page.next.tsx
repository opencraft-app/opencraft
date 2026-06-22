import type { Metadata } from 'next';

import { PublicCookiePolicyPage } from '@next-site/legal-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';

export const metadata: Metadata = DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
  ? {
      title: 'Cookie Policy',
      description: 'LightVela Cookie Policy covering cookie types, purposes, and management options.',
    }
  : {
      title: 'Cookies 政策',
      description: 'LightVela Cookies 政策，说明 cookies 的类型、用途和管理方式。',
    };

export default function CookiePolicyRoute() {
  return <PublicCookiePolicyPage />;
}
