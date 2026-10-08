'use client';

import { usePathname } from 'next/navigation';
import React, { type ReactNode } from 'react';

import { AgentsPageClient } from '@next-site/agents-page-client';
import {
  AGENT_LAB_SECTION_ID_BY_SLUG,
  AGENT_SECTION_ID_BY_SLUG,
  type AgentSectionId,
} from '@/lib/agent-routes';

export interface AgentsConsoleRoute {
  readonly slug?: string;
  readonly sectionId?: AgentSectionId;
}

/** Maps a console URL to its section; `null` leaves the URL to its page (for example notFound). */
export function resolveAgentsConsoleRoute(pathname: string): AgentsConsoleRoute | null {
  const [root, first, second, ...rest] = pathname.split('/').filter(Boolean);
  if (root !== 'agents' || rest.length > 0) return null;
  if (first === undefined) return {};
  if (second === undefined) {
    return Object.hasOwn(AGENT_SECTION_ID_BY_SLUG, first)
      ? { slug: first, sectionId: AGENT_SECTION_ID_BY_SLUG[first] }
      : null;
  }
  return first === 'labs' && Object.hasOwn(AGENT_LAB_SECTION_ID_BY_SLUG, second)
    ? { slug: second, sectionId: AGENT_LAB_SECTION_ID_BY_SLUG[second] }
    : null;
}

/**
 * Keeps one console instance across `/agents/*` navigation. Section pages only own
 * routing metadata and validation; remounting the console per section would restart
 * the embedded chat, its Host connection and every gate on each sidebar click.
 */
export function AgentsConsoleLayout({ children }: { children: ReactNode }) {
  const route = resolveAgentsConsoleRoute(usePathname() ?? '');
  return (
    <>
      {route === null ? null : <AgentsPageClient initialSectionSlug={route.slug} sectionId={route.sectionId} />}
      {children}
    </>
  );
}
