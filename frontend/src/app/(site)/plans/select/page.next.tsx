import type { Metadata } from 'next';

import { PlanSelectPageClient } from '@next-site/plan-select-page-client';

export const metadata: Metadata = {
  title: '选择套餐',
  robots: {
    index: false,
    follow: false,
  },
};

export default function PlanSelectPage() {
  return <PlanSelectPageClient />;
}
