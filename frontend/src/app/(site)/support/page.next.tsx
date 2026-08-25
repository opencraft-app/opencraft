import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SupportPageClient } from '@next-site/support-page-client';
import { isGlobal } from '@/lib/region';

export const metadata: Metadata = {
  title: 'Support',
  description: 'Submit feedback, report issues, or request features.',
};

export default function SupportPage() {
  if (isGlobal) notFound();

  return <SupportPageClient />;
}
