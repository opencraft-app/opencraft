import type { Metadata } from 'next';

import { PublicPrivacyPolicyPage } from '@next-site/legal-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/privacy-policy',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US' ? 'Privacy Policy' : '隐私政策',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
      ? 'LightVela Privacy Policy covering personal information processing, storage, sharing, and user rights.'
      : 'LightVela 隐私政策，说明个人信息的处理、存储、共享和用户权利。',
});

export default function PrivacyPolicyRoute() {
  return <PublicPrivacyPolicyPage />;
}
