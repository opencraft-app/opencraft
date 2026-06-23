import type { Metadata } from 'next';

import { PublicCookiePolicyPage } from '@next-site/legal-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/cookie-policy',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US' ? 'Cookie Policy' : 'Cookies 政策',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela Cookie Policy covering cookie types, purposes, and management options.'
      : 'LightVela Cookies 政策，说明 cookies 的类型、用途和管理方式。',
});

export default function CookiePolicyRoute() {
  return <PublicCookiePolicyPage />;
}
