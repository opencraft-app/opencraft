import type { Metadata } from 'next';

import { getAgentDocumentMetadata } from '@next-site/agent-document-metadata';

export const metadata: Metadata = {
  title: getAgentDocumentMetadata().title,
  robots: {
    index: false,
    follow: false,
  },
};

/** Rendered by the persistent console in `agents/layout.next.tsx`. */
export default function AgentsPage() {
  return null;
}
