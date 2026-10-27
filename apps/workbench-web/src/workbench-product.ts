import { workbenchIconMetrics } from "@opencraft/design-system/tokens";
import { createContext, useContext } from "react";
import { parseWorkbenchPresentation, type WorkbenchPresentation } from "./workbench-presentation";
interface WorkbenchBuildEnvironment {
  readonly VITE_OPENCRAFT_PRODUCT_ID?: string;
}

export function resolveWorkbenchProductId(
  environment: WorkbenchBuildEnvironment | undefined,
): string {
  return environment?.VITE_OPENCRAFT_PRODUCT_ID?.trim() || "opencraft";
}

/** Identity scopes data and diagnostics; it does not choose presentation. */
export const workbenchProductId = resolveWorkbenchProductId(
  import.meta.env as WorkbenchBuildEnvironment | undefined,
);

/** Product identity, independent of the user's color-theme selection. */
export const WorkbenchProductContext = createContext(workbenchProductId);
export const useWorkbenchProductId = () => useContext(WorkbenchProductContext);
export const workbenchPresentation = parseWorkbenchPresentation(import.meta.env?.VITE_OPENCRAFT_PRESENTATION);
export const WorkbenchPresentationContext = createContext(workbenchPresentation);
export const useWorkbenchPresentation = () => useContext(WorkbenchPresentationContext);

/** Root-local scale; Shadow hosts and full-page roots use the same tokens. */
export function applyWorkbenchProductPresentation(root: HTMLElement, productId: string, presentation: WorkbenchPresentation = workbenchPresentation): void {
  root.dataset.workbenchProduct = productId;
  root.dataset.workbenchIconStyle = presentation.iconStyle;
  const classic = presentation.iconStyle === "classic";
  root.style.setProperty("--stroke-icon", String((classic ? workbenchIconMetrics.classic : workbenchIconMetrics.core).stroke));
  root.style.setProperty("--stroke-icon-navigation", String(workbenchIconMetrics.coreNavigation.stroke));
  root.style.setProperty("--size-icon-navigation", classic ? "auto" : `${workbenchIconMetrics.core.navigation}px`);
  // Shell density is a fallback; legacy product consumers retain their own SVG dimensions.
  if (classic) root.style.setProperty("--size-product-navigation-icon", "auto");
  else root.style.removeProperty("--size-product-navigation-icon");
  root.style.setProperty("--space-settings-navigation-inline", classic ? "12px" : "0px");
  root.style.setProperty("--space-icon-leading-inset", classic ? "0px" : "calc((var(--size-navigation-leading-slot) - var(--size-icon-navigation)) / 2)");
}
