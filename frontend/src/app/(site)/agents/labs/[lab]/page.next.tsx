import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AGENT_LAB_SECTION_ID_BY_SLUG } from "@/lib/agent-routes";

export const metadata: Metadata = {
  title: "DeepSeek Harness",
  robots: {
    index: false,
    follow: false,
  },
};

export function generateStaticParams(): Array<{ lab: string }> {
  return Object.keys(AGENT_LAB_SECTION_ID_BY_SLUG).map((lab) => ({ lab }));
}

export default async function AgentLabPage({ params }: { params: Promise<{ lab: string }> }) {
  const { lab } = await params;
  if (!AGENT_LAB_SECTION_ID_BY_SLUG[lab]) notFound();
  // Rendered by the persistent console in `agents/layout.next.tsx`.
  return null;
}
