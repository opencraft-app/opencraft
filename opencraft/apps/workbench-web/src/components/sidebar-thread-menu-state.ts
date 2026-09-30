export type SidebarThreadMenuKind = "context" | "dropdown";

export interface OpenSidebarThreadMenu {
  readonly hostId: string;
  readonly threadId: string;
  readonly kind: SidebarThreadMenuKind;
}

export function isSidebarThreadMenuOpen(
  current: OpenSidebarThreadMenu | null,
  target: OpenSidebarThreadMenu,
): boolean {
  return current?.hostId === target.hostId
    && current.threadId === target.threadId
    && current.kind === target.kind;
}

export function updateOpenSidebarThreadMenu(
  current: OpenSidebarThreadMenu | null,
  target: OpenSidebarThreadMenu,
  open: boolean,
): OpenSidebarThreadMenu | null {
  if (open) return target;
  // A closing callback from the previous menu must not close a newer one.
  return isSidebarThreadMenuOpen(current, target) ? null : current;
}
