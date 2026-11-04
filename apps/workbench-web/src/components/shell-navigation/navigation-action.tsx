import React from "react";
import { SettingsGearIcon } from "@opencraft/design-system-web/action-icons";
import { workbenchIconMetrics } from "@opencraft/design-system/tokens";
import { useWorkbenchPresentation } from "../../workbench-product";
import { createElement } from "react";
import { resolveWorkbenchIcon } from "../ui/workbench-icon";
export interface NavigationAction {
  readonly id: string;
  readonly title: string;
  /** Compact visible copy; title remains the complete accessible name. */
  readonly shortTitle?: string;
  /** Resolved contribution copy; the Shell owns badge layout and visibility. */
  readonly badge?: string;
  readonly icon?: string;
  readonly active?: boolean;
  readonly expanded?: boolean;
  readonly onInvoke: () => void;
}

/** Semantic glyph mapping is platform-owned; CSS tokens own the physical scale. */
export function NavigationIcon({ name, size, selected = false }: {
  name?: string;
  size?: number;
  selected?: boolean;
}) {
  // Destination selection belongs to the shared control surface. Artwork
  // stays outline at one weight in every product presentation.
  const classic = useWorkbenchPresentation().iconStyle === "classic";
  const icon = resolveWorkbenchIcon(name, classic, "navigation");
  const props = {
    size: size ?? (classic ? workbenchIconMetrics.classic.navigation : workbenchIconMetrics.core.navigation),
    "aria-hidden": true,
    focusable: false,
    "data-navigation-glyph-variant": selected ? "selected" : "outline",
    fill: "none",
    strokeWidth: workbenchIconMetrics.coreNavigation.stroke,
  };
  if (name === "settings") return <SettingsGearIcon size={props.size} data-navigation-glyph-variant={selected ? "selected" : "outline"} />;
  return createElement(icon, props);
}
