import type { Metadata } from 'next';

import { PublicPrivacyPolicyPage } from '@next-site/legal-pages';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';

export const metadata: Metadata = DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US'
  ? {
      title: 'Privacy Policy',
      description: 'LightVela Privacy Policy covering personal information processing, storage, sharing, and user rights.',
    }
  : {
      title: '隐私政策',
      description: 'LightVela 隐私政策，说明个人信息的处理、存储、共享和用户权利。',
    };

export default function PrivacyPolicyRoute() {
  return <PublicPrivacyPolicyPage />;
}
