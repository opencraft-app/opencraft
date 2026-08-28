import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getAgentDocumentMetadata } from '@next-site/agent-document-metadata';
import { AgentsPageClient } from '@next-site/agents-page-client';
import { AGENT_SECTION_ID_BY_SLUG } from '@/lib/agent-routes';
import { isGlobal } from '@/lib/region';

export const metadata: Metadata = {
  title: getAgentDocumentMetadata().title,
  robots: {
    index: false,
    follow: false,
  },
};

export function generateStaticParams(): Array<{ section: string }> {
  return Object.keys(AGENT_SECTION_ID_BY_SLUG)
    .filter((section) => isGlobal || section !== 'websites')
    .map((section) => ({ section }));
}

export default async function AgentsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const sectionId = AGENT_SECTION_ID_BY_SLUG[section];
  if (!sectionId || (!isGlobal && sectionId === 'website')) notFound();
  return <AgentsPageClient initialSectionSlug={section} sectionId={sectionId} />;
}
