import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PublicUrlLang } from '@next-site/public-locale';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return [];
}

export async function generateMetadata(): Promise<Metadata> {
  notFound();
}

export default function LocalizedSupportPage() {
  notFound();
}
