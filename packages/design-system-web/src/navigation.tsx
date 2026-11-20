import React, { forwardRef, type HTMLAttributes } from "react";
import { Button, type ButtonProps } from "./button";

/** The list owns the gutter around row surfaces; the Shell owns its outer slot. */
export interface NavigationListProps extends Omit<HTMLAttributes<HTMLElement>, "aria-label"> {
  readonly label: string;
  readonly compact?: boolean;
  /** Shell destination lists share the same outer reading axis. */
  /** Contained lists reuse a host that already supplies the outer gutter. */
  readonly inset?: "default" | "sidebar" | "contained";
}
export const NavigationList = forwardRef<HTMLElement, NavigationListProps>(function NavigationList({ label, className, compact = false, inset = "default", ...props }, ref) {
  return <nav {...props} ref={ref} aria-label={label} data-navigation-inset={inset === "default" ? undefined : inset} data-navigation-compact={compact || undefined} className={["ui-navigation-list", className].filter(Boolean).join(" ")} />;
});

export const NavigationGroup = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function NavigationGroup({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={["ui-navigation-group", className].filter(Boolean).join(" ")} />;
});

/** Row children expose data-navigation-leading/label/trailing slots. Direct
 * leading SVGs remain supported for plugin compatibility. Surface decoration
 * is Button-owned and must never be selected as label content. */
export type NavigationItemProps = Omit<ButtonProps, "size" | "variant" | "surface" | "contentLayout"> & {
  /** Compact destination rails retain the same state owner as labeled rows. */
  readonly compact?: boolean;
  /** Standalone rows can share sidebar geometry without adding a nested nav. */
  readonly inset?: "default" | "sidebar";
};
export const NavigationItem = forwardRef<HTMLButtonElement, NavigationItemProps>(function NavigationItem({ className, compact = false, inset = "default", ...props }, ref) {
  return <Button {...props} ref={ref} className={["ui-navigation-item", className].filter(Boolean).join(" ")}
    size="navigation" variant="ghost" surface="integrated" data-navigation-inset={inset === "default" ? undefined : inset} contentLayout={compact ? "icon" : "row"} />;
});

/** Non-interactive list feedback; callers retain copy, typography and tone. */
export const NavigationEmpty = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function NavigationEmpty({ className, role = "status", ...props }, ref) {
  return <div {...props} ref={ref} role={role} className={["ui-navigation-empty", className].filter(Boolean).join(" ")} />;
});
/** Quiet numeric metadata, not an unread/error status badge. */
export const NavigationCount = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function NavigationCount({ className, ...props }, ref) {
  return <span {...props} ref={ref} data-navigation-trailing="" className={["ui-navigation-count", className].filter(Boolean).join(" ")} />;
});
