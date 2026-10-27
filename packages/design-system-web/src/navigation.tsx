import React, { forwardRef, type HTMLAttributes } from "react";
import { Button, type ButtonProps } from "./button";

/** The list owns the gutter around row surfaces; the Shell owns its outer slot. */
export interface NavigationListProps extends Omit<HTMLAttributes<HTMLElement>, "aria-label"> {
  readonly label: string;
}
export const NavigationList = forwardRef<HTMLElement, NavigationListProps>(function NavigationList({ label, className, ...props }, ref) {
  return <nav {...props} ref={ref} aria-label={label} className={["ui-navigation-list", className].filter(Boolean).join(" ")} />;
});

export const NavigationGroup = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function NavigationGroup({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={["ui-navigation-group", className].filter(Boolean).join(" ")} />;
});

export type NavigationItemProps = Omit<ButtonProps, "size" | "variant" | "surface" | "contentLayout">;
export const NavigationItem = forwardRef<HTMLButtonElement, NavigationItemProps>(function NavigationItem({ className, ...props }, ref) {
  return <Button {...props} ref={ref} className={["ui-navigation-item", className].filter(Boolean).join(" ")}
    size="navigation" variant="ghost" surface="integrated" contentLayout="row" />;
});
