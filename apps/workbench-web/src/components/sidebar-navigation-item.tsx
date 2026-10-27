import type { ReactNode } from "react";
import { NavigationItem } from "@opencraft/design-system-web/navigation";

export function SidebarNavigationItem({
  active = false,
  icon,
  onInvoke,
  title,
}: {
  readonly active?: boolean;
  readonly icon: ReactNode;
  readonly onInvoke: () => void;
  readonly title: string;
}) {
  return (
    <NavigationItem
      className="sidebar-navigation-item"
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onInvoke}
    >
      <span className="sidebar-navigation-item__icon" aria-hidden="true">{icon}</span>
      <span>{title}</span>
    </NavigationItem>
  );
}
