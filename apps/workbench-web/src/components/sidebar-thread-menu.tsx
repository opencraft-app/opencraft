import { Root as DropdownMenuRoot } from "@opencraft/design-system-web/dropdown-menu";
import { Root as ContextMenuRoot } from "@opencraft/design-system-web/context-menu";
import { useCallback, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type { ThreadBadgeContribution, ThreadBadgeProps } from "@opencraft/extension-react";
import { ThreadRowMenu } from "./thread-management";
import { SidebarThreadMenuStore, type OpenSidebarThreadMenu } from "./sidebar-thread-menu-state";

type Target = Pick<OpenSidebarThreadMenu, "hostId" | "threadId" | "rowId">;
export function useSidebarRowMenu(store: SidebarThreadMenuStore, { hostId, threadId, rowId }: Target) {
  const subscribe = useCallback((listener: () => void) => store.subscribe({ hostId, threadId, rowId }, listener), [store, hostId, threadId, rowId]);
  const snapshot = useCallback(() => store.getKind({ hostId, threadId, rowId }), [store, hostId, threadId, rowId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function SidebarThreadRowMenu({ store, rowId, ...props }: Omit<ComponentProps<typeof ThreadRowMenu>, "openMenuKind"> & { store: SidebarThreadMenuStore; rowId?: string }) {
  const kind = useSidebarRowMenu(store, { ...props.target, rowId });
  return <ThreadRowMenu {...props} openMenuKind={kind === "context" || kind === "dropdown" ? kind : null} onPointerDown={event => {
    props.onPointerDown?.(event);
    // The nearest row trigger owns the native long press, rather than the list trigger.
    event.stopPropagation();
  }} />;
}

export function SidebarThreadBadge({ store, contribution, rowId, ...props }: Omit<ThreadBadgeProps, "open"> & { store: SidebarThreadMenuStore; contribution: ThreadBadgeContribution; rowId?: string }) {
  const kind = useSidebarRowMenu(store, { ...props, rowId });
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
