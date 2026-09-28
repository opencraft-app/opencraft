import type { Metadata } from 'next';

import { SupportPageClient } from '@next-site/support-page-client';

export const metadata: Metadata = {
  title: 'Support',
  description: 'Submit feedback, report issues, or request features.',
};

export default function SupportPage() {
  return <SupportPageClient />;
}
