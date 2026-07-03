import type { Metadata } from 'next';

import { SupportAdminPageClient } from '@next-site/support-admin-page-client';
import { isGlobal } from '@/lib/region';

export const metadata: Metadata = {
  title: isGlobal ? 'LightVela Feedback Console - Global' : 'LightVela 反馈查询后台 - 国内站',
  description: isGlobal ? 'Review and search user feedback submissions.' : '查看与检索用户反馈提交记录。',
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

export default function SupportLvConsolePage() {
  return <SupportAdminPageClient />;
}
