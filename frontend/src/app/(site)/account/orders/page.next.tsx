import type { Metadata } from 'next';

import { AccountOrdersPageClient } from '@next-site/account-orders-page-client';

export const metadata: Metadata = {
  title: '订单记录',
  robots: {
    index: false,
    follow: false,
  },
};

export default function AccountOrdersPage() {
  return <AccountOrdersPageClient />;
}
