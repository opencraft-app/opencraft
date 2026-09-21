import {
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * Owns the user's sidebar intent. AppShell projects it against the complete
 * window budget, so an automatic collapse cannot overwrite a manual choice.
 */

interface ResponsiveSidebarDock {
  readonly sidebarOpen: boolean;
  readonly setSidebarOpen: Dispatch<SetStateAction<boolean>>;
}

export function useResponsiveSidebarDock(): ResponsiveSidebarDock {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return { sidebarOpen, setSidebarOpen };
}
