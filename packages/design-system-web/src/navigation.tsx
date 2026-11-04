import React, { forwardRef, type HTMLAttributes } from "react";
import { Button, type ButtonProps } from "./button";

/** The list owns the gutter around row surfaces; the Shell owns its outer slot. */
export interface NavigationListProps extends Omit<HTMLAttributes<HTMLElement>, "aria-label"> {
  readonly label: string;
  readonly compact?: boolean;
  /** Shell destination lists share the same outer reading axis. */
  readonly inset?: "default" | "sidebar";
}
export const NavigationList = forwardRef<HTMLElement, NavigationListProps>(function NavigationList({ label, className, compact = false, inset = "default", ...props }, ref) {
  return <nav {...props} ref={ref} aria-label={label} data-navigation-inset={inset === "sidebar" ? "sidebar" : undefined} data-navigation-compact={compact || undefined} className={["ui-navigation-list", className].filter(Boolean).join(" ")} />;
});

export const NavigationGroup = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function NavigationGroup({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={["ui-navigation-group", className].filter(Boolean).join(" ")} />;
});

export type NavigationItemProps = Omit<ButtonProps, "size" | "variant" | "surface" | "contentLayout"> & {
  /** Compact destination rails retain the same state owner as labeled rows. */
  readonly compact?: boolean;
};
export const NavigationItem = forwardRef<HTMLButtonElement, NavigationItemProps>(function NavigationItem({ className, compact = false, ...props }, ref) {
  return <Button {...props} ref={ref} className={["ui-navigation-item", className].filter(Boolean).join(" ")}
    size="navigation" variant="ghost" surface="integrated" contentLayout={compact ? "icon" : "row"} />;
});
