import type { Metadata } from 'next';

import { AgentsPageClient } from '@next-site/agents-page-client';

export const metadata: Metadata = {
  title: '我的智能体伙伴',
  robots: {
    index: false,
    follow: false,
  },
};

export default function AgentsPage() {
  return <AgentsPageClient />;
}
