import { SwipeActions } from "@opencraft/design-system-web/swipe-actions";
import { PinIcon, PinOffIcon, CloseIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import type { ReactNode } from "react";
import { useSidebarRowMenu } from "./sidebar-thread-menu";
import type { SidebarThreadMenuStore } from "./sidebar-thread-menu-state";

export type RecentRowAction = "pin" | "unpin" | "dismiss";
export function recentRowLabels(intl: ReturnType<typeof useIntl>, pinned: boolean) {
  return {
    pin: pinned ? intl.formatMessage({ id: "sidebar.recent.unpin", defaultMessage: "Unpin from top" })
      : intl.formatMessage({ id: "sidebar.recent.pin", defaultMessage: "Pin to top" }),
    dismiss: intl.formatMessage({ id: "sidebar.recent.dismiss", defaultMessage: "Remove from Recent" }),
  };
}

export function SidebarRecentRow({ children, store, hostId, threadId, rowId, pinned, pending, onAction }: {
  children: ReactNode; store: SidebarThreadMenuStore; hostId: string; threadId: string; rowId: string;
  pinned: boolean; pending: boolean; onAction(action: RecentRowAction): void;
}) {
  const intl = useIntl(), labels = recentRowLabels(intl, pinned);
  const menu = useSidebarRowMenu(store, { hostId, threadId, rowId });
  return <div data-sidebar-gesture="ignore" className="sidebar-recent-row" aria-busy={pending || undefined}>
    <SwipeActions disabled={pending || menu !== null}
      left={{ label: labels.dismiss, icon: <CloseIcon size={16} />, onInvoke: () => onAction("dismiss") }}
      right={{ label: labels.pin, icon: pinned ? <PinOffIcon size={16} /> : <PinIcon size={16} />, onInvoke: () => onAction(pinned ? "unpin" : "pin") }}>
      {children}
    </SwipeActions>
  </div>;
}
