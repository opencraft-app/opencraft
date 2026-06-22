import type { Metadata } from 'next';

import { PublicPrivacyPolicyPage } from '@next-site/legal-pages';

export const metadata: Metadata = {
  title: '隐私政策',
  description: 'LightVela 隐私政策，说明个人信息的处理、存储、共享和用户权利。',
};

export default function PrivacyPolicyRoute() {
  return <PublicPrivacyPolicyPage />;
}
