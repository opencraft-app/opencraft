import type { Metadata } from 'next';

import { PublicCookiePolicyPage } from '@next-site/legal-pages';

export const metadata: Metadata = {
  title: 'Cookies 政策',
  description: 'LightVela Cookies 政策，说明 cookies 的类型、用途和管理方式。',
};

export default function CookiePolicyRoute() {
  return <PublicCookiePolicyPage />;
}
