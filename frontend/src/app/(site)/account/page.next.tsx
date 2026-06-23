import type { Metadata } from 'next';

import { AccountPageClient } from '@next-site/account-page-client';

export const metadata: Metadata = {
  title: '账号管理',
  robots: {
    index: false,
    follow: false,
  },
};

export default function AccountPage() {
  return <AccountPageClient />;
}
