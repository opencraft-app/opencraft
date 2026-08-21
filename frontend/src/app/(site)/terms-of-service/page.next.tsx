import type { Metadata } from 'next';

import { PublicTermsOfServicePage } from '@next-site/legal-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/terms-of-service',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US' ? 'Terms of Service' : '服务条款',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela Terms of Service for accessing and using the LightVela service.'
      : 'LightVela 服务条款，适用于访问和使用 LightVela 服务。',
});

export default function TermsOfServiceRoute() {
  return <PublicTermsOfServicePage />;
}
