import { shellNavigationMetrics } from "@opencraft/workbench-runtime";

/** Overlay budgets its own rectangle; never reuses the dock's remaining-main-space decision. */
export function floatingSidebarLayout(input: { viewportWidth: number; contextWidth: number; primaryWidth: number; contextAvailable: boolean; navigationAvailable: boolean; expanded: boolean }) {
  const available = Math.max(0, input.viewportWidth - 24);
  const canExpand = !input.contextAvailable || available >= input.primaryWidth + 240;
  const detent = input.expanded && canExpand ? "expanded" as const : "compact" as const;
  const primaryWidth = !input.navigationAvailable ? 0 : !input.contextAvailable
    ? Math.min(available, Math.max(input.contextWidth, 260))
    : Math.min(available, detent === "expanded" ? input.primaryWidth : shellNavigationMetrics.compactWidth);
  const contextWidth = input.contextAvailable ? Math.min(input.contextWidth, Math.max(0, available - primaryWidth)) : 0;
  return { primaryWidth, contextWidth, width: primaryWidth + contextWidth, detent, canExpand };
}
