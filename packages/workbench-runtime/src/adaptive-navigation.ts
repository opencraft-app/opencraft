/** Navigation is semantic. Viewport size is deliberately absent from this store. */
export interface NavigationNode { readonly id: string; }
export interface NavigationPage extends NavigationNode {
  readonly minWidth: number;
}

export class AdaptiveNavigation<T extends NavigationNode = NavigationPage> {
  private path: readonly T[];
  private readonly listeners = new Set<() => void>();
  /** Restore a Router-owned path without creating a second history authority. */
  constructor(root: T, descendants: readonly T[] = []) {
    const pages = [root, ...descendants];
    if (pages.length > 32 || new Set(pages.map(page => page.id)).size !== pages.length) throw new Error("Invalid navigation path");
    this.path = Object.freeze(pages.map(page => this.validate(page)));
  }
  private validate(page: T): T {
    if (!page.id || ("minWidth" in page && (typeof page.minWidth !== "number" || !Number.isFinite(page.minWidth) || page.minWidth <= 0))) throw new Error("Invalid navigation page");
    return Object.freeze({ ...page });
  }
  getSnapshot = (): readonly T[] => this.path;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  /** Replace descendants of a selected parent, rather than stacking sibling details. */
  enter(parentId: string, page: T): void {
    const parent = this.path.findIndex(entry => entry.id === parentId);
    if (parent < 0) throw new Error("Navigation parent is not in the current path");
    if (parent >= 31) throw new Error("Navigation path is too deep");
    const next = this.validate(page);
    if (this.path.slice(0, parent + 1).some(entry => entry.id === next.id)) throw new Error("Duplicate navigation identity");
    if (this.path.length === parent + 2 && this.path[parent + 1].id === next.id) return;
    this.path = Object.freeze([...this.path.slice(0, parent + 1), next]);
    this.listeners.forEach(listener => listener());
  }
  back(): boolean {
    if (this.path.length === 1) return false;
    this.path = Object.freeze(this.path.slice(0, -1));
    this.listeners.forEach(listener => listener());
    return true;
  }
}

/** Largest fitting suffix of the hierarchy. Preview never creates navigation. */
export function projectNavigation(path: readonly NavigationPage[], width: number, preview?: NavigationPage): readonly string[] {
  if (!path.length) return [];
  const available = Number.isFinite(width) ? Math.max(0, width) : 0;
  const leaf = path[path.length - 1];
  const pages = preview && !path.some(page => page.id === preview.id) && available >= leaf.minWidth + preview.minWidth ? [...path, preview] : path;
  let first = pages.length - 1;
  let occupied = pages[first].minWidth;
  while (first > 0 && occupied + pages[first - 1].minWidth <= available) occupied += pages[--first].minWidth;
  return pages.slice(first).map(page => page.id);
}
