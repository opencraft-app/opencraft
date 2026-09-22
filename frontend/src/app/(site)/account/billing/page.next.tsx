import type { Metadata } from 'next';
import { PlansBillingPageClient } from '@next-site/account-page-client';

export const metadata: Metadata = {
  title: '套餐与费用',
  robots: { index: false, follow: false },
};

export default function PlansBillingPage() {
  return <PlansBillingPageClient />;
}
