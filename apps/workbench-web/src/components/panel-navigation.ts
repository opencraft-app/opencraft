import { createContext, useContext } from 'react';
import type { PanelTabDescriptor } from '@opencraft/workbench-panels';

/** A projection of the existing panel owner, not a second tab directory. */
export const PanelNavigationContext = createContext<{
  readonly tabs: readonly PanelTabDescriptor[];
  readonly activeTabId: string | null;
  activate(tabId: string): void;
  close(tab: PanelTabDescriptor): void;
  createBrowser?: () => void | Promise<void>;
} | null>(null);
export const usePanelNavigation = () => useContext(PanelNavigationContext);
