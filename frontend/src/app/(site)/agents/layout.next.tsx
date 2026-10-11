import type { ReactNode } from 'react';

import { AgentsConsoleLayout } from '@next-site/agents-console-layout';

/** The Agents console persists across `/agents/*` navigation; pages only validate the route. */
export default function AgentsLayout({ children }: { children: ReactNode }) {
  return <AgentsConsoleLayout>{children}</AgentsConsoleLayout>;
}
