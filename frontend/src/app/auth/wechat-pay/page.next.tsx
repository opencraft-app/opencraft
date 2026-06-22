import type { Metadata } from 'next';

import { WeChatPayPage } from '@/pages/auth/wechat-pay-page';

export const metadata: Metadata = {
  title: '微信支付',
  robots: {
    index: false,
    follow: false,
  },
};

export default function WeChatPayRoute() {
  return <WeChatPayPage />;
}
