import type { Metadata } from 'next';

import { getAgentDocumentMetadata } from '@next-site/agent-document-metadata';
import { AgentsPageClient } from '@next-site/agents-page-client';

export const metadata: Metadata = {
  title: getAgentDocumentMetadata().title,
  robots: {
    index: false,
    follow: false,
  },
};

export default function AgentsPage() {
  return <AgentsPageClient />;
}
