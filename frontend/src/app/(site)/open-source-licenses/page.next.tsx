import type { Metadata } from 'next';

import { PublicOpenSourceLicensesPage } from '@next-site/legal-pages';

export const metadata: Metadata = {
  title: '开源声明',
  description: 'LightVela 使用的开源软件归属与许可证声明。',
};

export default function OpenSourceLicensesRoute() {
  return <PublicOpenSourceLicensesPage />;
}
