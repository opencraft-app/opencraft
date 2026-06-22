import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AgentsPageClient } from '@next-site/agents-page-client';
import { AGENT_SECTION_ID_BY_SLUG } from '@/router/paths';

export const metadata: Metadata = {
  title: '我的智能体伙伴',
  robots: {
    index: false,
    follow: false,
  },
};

export function generateStaticParams(): Array<{ section: string }> {
  return Object.keys(AGENT_SECTION_ID_BY_SLUG).map((section) => ({ section }));
}

export default async function AgentsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!AGENT_SECTION_ID_BY_SLUG[section]) notFound();
  return <AgentsPageClient sectionSlug={section} />;
}
