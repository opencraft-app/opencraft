import { Root as DropdownMenuRoot } from "@opencraft/design-system-web/dropdown-menu";
import { Root as ContextMenuRoot } from "@opencraft/design-system-web/context-menu";
import { useCallback, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type { ThreadBadgeContribution, ThreadBadgeProps } from "@opencraft/extension-react";
import { ThreadRowMenu } from "./thread-management";
import { SidebarThreadMenuStore, type OpenSidebarThreadMenu } from "./sidebar-thread-menu-state";

type Target = Pick<OpenSidebarThreadMenu, "hostId" | "threadId">;
export function useSidebarRowMenu(store: SidebarThreadMenuStore, { hostId, threadId }: Target) {
  const subscribe = useCallback((listener: () => void) => store.subscribe({ hostId, threadId }, listener), [store, hostId, threadId]);
  const snapshot = useCallback(() => store.getKind({ hostId, threadId }), [store, hostId, threadId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function SidebarThreadRowMenu({ store, ...props }: Omit<ComponentProps<typeof ThreadRowMenu>, "openMenuKind"> & { store: SidebarThreadMenuStore }) {
  const kind = useSidebarRowMenu(store, props.target);
  return <ThreadRowMenu {...props} openMenuKind={kind === "context" || kind === "dropdown" ? kind : null} onPointerDown={event => {
    props.onPointerDown?.(event);
    // The nearest row trigger owns the native long press, rather than the list trigger.
    event.stopPropagation();
  }} />;
}

export function SidebarThreadBadge({ store, contribution, ...props }: Omit<ThreadBadgeProps, "open"> & { store: SidebarThreadMenuStore; contribution: ThreadBadgeContribution }) {
  const kind = useSidebarRowMenu(store, props);
  return <contribution.Component {...props} open={kind === "badge"} />;
}

/** The list-level menu subscribes without rebuilding the conversation list. */
export function SidebarFiltersMenu({ store, children }: { store: SidebarThreadMenuStore; children: ReactNode }) {
  const open = useSyncExternalStore(store.subscribeFilters, store.getFiltersOpen, store.getFiltersOpen);
  return <DropdownMenuRoot open={open} onOpenChange={store.setFiltersOpen}>{children}</DropdownMenuRoot>;
}

/** The list context entrance shares the owner while keeping list rendering isolated. */
export function SidebarListContextMenu({ store, children }: { store: SidebarThreadMenuStore; children: ReactNode }) {
  const open = useSyncExternalStore(store.subscribeListContext, store.getListContextOpen, store.getListContextOpen);
  return <ContextMenuRoot open={open} onOpenChange={store.setListContextOpen}>{children}</ContextMenuRoot>;
}
