import type { Metadata } from 'next';

import { SubscribePageClient } from '@next-site/subscribe-page-client';

export const metadata: Metadata = {
  title: '选择套餐',
  robots: {
    index: false,
    follow: false,
  },
};

export default function SubscribePage() {
  return <SubscribePageClient />;
}
