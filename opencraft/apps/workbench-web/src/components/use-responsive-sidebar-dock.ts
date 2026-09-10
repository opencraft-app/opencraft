import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * The Web workbench always uses desktop topology. This threshold is only a
 * space-pressure policy: entering a narrow desktop window closes the dock via
 * its normal animation. It does not create a mobile/overlay presentation.
 */
export const SIDEBAR_AUTO_COLLAPSE_MEDIA_QUERY = "(max-width: 720px)";

interface ResponsiveSidebarDock {
  readonly sidebarOpen: boolean;
  readonly setSidebarOpen: Dispatch<SetStateAction<boolean>>;
}

export function useResponsiveSidebarDock(): ResponsiveSidebarDock {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(SIDEBAR_AUTO_COLLAPSE_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(SIDEBAR_AUTO_COLLAPSE_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return { sidebarOpen, setSidebarOpen };
}
