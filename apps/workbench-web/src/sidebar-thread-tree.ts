export interface SidebarTreeThread {
  readonly id: string;
  readonly connectionHostId: string;
  readonly parentThreadId?: string | null;
  readonly visibility?: "visible" | "hidden";
  readonly updatedAt: number;
}

export interface SidebarThreadTreeNode<T extends SidebarTreeThread> {
  readonly thread: T;
  readonly children: readonly SidebarThreadTreeNode<T>[];
}

export function sidebarThreadIdentity(thread: Pick<SidebarTreeThread, "connectionHostId" | "id">): string {
  return JSON.stringify([thread.connectionHostId, thread.id]);
}

/** A replaceable view of the Host's topology. Filtering never deletes catalog rows.
 * Missing/filtered parents become roots; equal IDs on other Hosts cannot adopt them. */
export function sidebarThreadTree<T extends SidebarTreeThread>(threads: readonly T[]) {
  const nodes = new Map<string, { thread: T; children: SidebarThreadTreeNode<T>[] }>();
  for (const thread of threads) {
    if (thread.visibility !== "hidden") nodes.set(sidebarThreadIdentity(thread), { thread, children: [] });
  }
  const parents = new Map<string, string>();
  for (const [key, { thread }] of nodes) {
    if (!thread.parentThreadId) continue;
    const parentKey = sidebarThreadIdentity({ connectionHostId: thread.connectionHostId, id: thread.parentThreadId });
    if (nodes.has(parentKey)) parents.set(key, parentKey);
  }
  // A malformed provider must not hang rendering. Break each cycle at its
  // canonical identity, independent of response order and refresh timing.
  const checked = new Set<string>();
  for (const key of nodes.keys()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = key;
    while (current !== undefined && !checked.has(current)) {
      const cycle = positions.get(current);
      if (cycle !== undefined) {
        parents.delete(path.slice(cycle).sort()[0]!);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }
    for (const visited of path) checked.add(visited);
  }
  const roots: SidebarThreadTreeNode<T>[] = [];
  for (const [key, node] of nodes) {
    const parent = parents.get(key);
    if (parent === undefined) roots.push(node);
    else nodes.get(parent)!.children.push(node);
  }
  const compare = (left: SidebarThreadTreeNode<T>, right: SidebarThreadTreeNode<T>) =>
    right.thread.updatedAt - left.thread.updatedAt
      || sidebarThreadIdentity(left.thread).localeCompare(sidebarThreadIdentity(right.thread));
  const rootByIdentity = new Map<string, string>();
  const pending = roots.map(node => ({ node, root: sidebarThreadIdentity(node.thread) }));
  for (let index = 0; index < pending.length; index++) {
    const { node, root } = pending[index]!;
    rootByIdentity.set(sidebarThreadIdentity(node.thread), root);
    // All array containers here are owned by this projection.
    nodes.get(sidebarThreadIdentity(node.thread))!.children.sort(compare);
    for (const child of node.children) pending.push({ node: child, root });
  }
  roots.sort(compare);
  return { roots, nodes: nodes as ReadonlyMap<string, SidebarThreadTreeNode<T>>, rootByIdentity };
}
