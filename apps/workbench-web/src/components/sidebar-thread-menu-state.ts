export type SidebarThreadMenuKind = "context" | "dropdown";

export interface OpenSidebarThreadMenu {
  readonly hostId: string;
  readonly threadId: string;
  readonly kind: SidebarThreadMenuKind | "badge" | "resources";
}

export type OpenSidebarMenu = OpenSidebarThreadMenu | { readonly kind: "filters" | "list-context" };

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

/** A Sidebar owns one open menu; only its previous/next row needs to render. */
export class SidebarThreadMenuStore {
  private current: OpenSidebarMenu | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  private key(target: Pick<OpenSidebarThreadMenu, "hostId" | "threadId">): string {
    return JSON.stringify([target.hostId, target.threadId]);
  }

  getSnapshot = (): OpenSidebarMenu | null => this.current;

  getFiltersOpen = (): boolean => this.current?.kind === "filters";

  subscribeFilters = (listener: () => void): (() => void) => this.subscribeKey("filters", listener);

  setFiltersOpen = (open: boolean): void => {
    if (open) this.set({ kind: "filters" });
    else if (this.current?.kind === "filters") this.set(null);
  };

  getListContextOpen = (): boolean => this.current?.kind === "list-context";

  subscribeListContext = (listener: () => void): (() => void) => this.subscribeKey("list-context", listener);

  setListContextOpen = (open: boolean): void => {
    if (open) this.set({ kind: "list-context" });
    else if (this.current?.kind === "list-context") this.set(null);
  };

  getKind(target: Pick<OpenSidebarThreadMenu, "hostId" | "threadId">): OpenSidebarThreadMenu["kind"] | null {
    return this.current && "hostId" in this.current && this.current.hostId === target.hostId && this.current.threadId === target.threadId ? this.current.kind : null;
  }

  subscribe(target: Pick<OpenSidebarThreadMenu, "hostId" | "threadId">, listener: () => void): () => void {
    return this.subscribeKey(this.key(target), listener);
  }

  private subscribeKey(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  update(target: OpenSidebarThreadMenu, open: boolean): void {
    if (open) this.set(target);
    else if (this.current && "hostId" in this.current) this.set(updateOpenSidebarThreadMenu(this.current, target, false));
  }

  close = (): void => { this.set(null); };

  private set(next: OpenSidebarMenu | null): void {
    const previous = this.current;
    if (previous === next) return;
    if (previous && next) {
      if (!("hostId" in previous) && !("hostId" in next) && previous.kind === next.kind) return;
      if ("hostId" in previous && "hostId" in next && isSidebarThreadMenuOpen(previous, next)) return;
    }
    this.current = next;
    const keys = new Set([previous, next].filter((target): target is OpenSidebarMenu => target !== null).map(target => "hostId" in target ? this.key(target) : target.kind));
    for (const key of keys) for (const listener of this.listeners.get(key) ?? []) listener();
  }
}
