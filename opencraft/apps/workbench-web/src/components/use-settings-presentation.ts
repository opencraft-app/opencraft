import { useLayoutEffect, useState } from "react";
import { projectNavigation } from "@opencraft/workbench-runtime";

/** Presentation only: resizing never changes the selected category or detail. */
export function useSettingsPresentation(preferredSidebarWidth: number) {
  const [width, setWidth] = useState(() => document.documentElement.clientWidth);
  const [indexRequested, setIndexRequested] = useState(false);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const observer = new ResizeObserver(() => setWidth(root.clientWidth));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const visible = projectNavigation([
    { id: "settings", minWidth: preferredSidebarWidth },
    { id: "content", minWidth: 620 },
  ], width);
  const compact = !visible.includes("settings");
  return {
    compact,
    showIndex: !compact || indexRequested,
    indexOnly: compact && indexRequested,
    sidebarWidth: compact ? width : preferredSidebarWidth,
    openIndex: () => setIndexRequested(true),
    openContent: () => setIndexRequested(false),
  };
}
