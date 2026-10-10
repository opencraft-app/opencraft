import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AgentDressupPreview } from '@/pages/marketing/agent-dressup-preview';

export const metadata: Metadata = {
  title: 'Hermes 变装试玩 · LightVela',
  robots: { index: false, follow: false },
};

export default function DressupPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <AgentDressupPreview />;
}
