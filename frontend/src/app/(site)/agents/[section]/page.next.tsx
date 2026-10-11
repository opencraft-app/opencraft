import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getAgentDocumentMetadata } from '@next-site/agent-document-metadata';
import { AGENT_SECTION_ID_BY_SLUG } from '@/lib/agent-routes';

export const metadata: Metadata = {
  title: getAgentDocumentMetadata().title,
  robots: {
    index: false,
    follow: false,
  },
};

export function generateStaticParams(): Array<{ section: string }> {
  return Object.keys(AGENT_SECTION_ID_BY_SLUG).map((section) => ({ section }));
}

/** Validates the section; the persistent console in `agents/layout.next.tsx` renders it. */
export default async function AgentsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!AGENT_SECTION_ID_BY_SLUG[section]) notFound();
  return null;
}
