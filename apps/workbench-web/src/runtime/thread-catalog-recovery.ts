import { CATALOG_MERKLE_CURSOR, catalogMerkle, parseThreadCatalogSnapshot, threadDirectoryIncomplete,
  type CatalogMerkleNode, type CatalogMerkleReply } from "@opencraft/appserver-protocol";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";

type Page = ThreadListResponse & { catalogMerkle?: CatalogMerkleReply; catalogDecorations?: unknown };
const indexes = new WeakMap<ThreadListResponse["data"], Promise<CatalogMerkleNode>>();
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Reuse only a complete certified raw baseline, never a notification overlay or display cache. */
export function canReconcileCatalog(base: ThreadListResponse | undefined): base is ThreadListResponse {
  return !!base && base.nextCursor === null && !threadDirectoryIncomplete(base) && !!parseThreadCatalogSnapshot(base)
    && base.data.length >= 64 && base.data.length <= 20000 && new Set(base.data.map(row => row.id)).size === base.data.length;
}
export async function catalogRecoveryIndex(base: ThreadListResponse, signal?: AbortSignal): Promise<CatalogMerkleNode> {
  let pending = indexes.get(base.data);
  if (!pending) {
    pending = catalogMerkle.buildAsync(base.data, pause);
    indexes.set(base.data, pending);
  }
  const root = await pending; signal?.throwIfAborted(); return root;
}

/** A new read is pinned to one Server snapshot. Publish only after checksum validation;
 * the existing live-fact overlay retains events arriving after the read boundary. */
export async function reconcileThreadCatalog(base: ThreadListResponse,
  read: (cursor: string) => Promise<ThreadListResponse>, signal?: AbortSignal): Promise<ThreadListResponse | null> {
  if (!canReconcileCatalog(base)) return null;
  const basis = await catalogRecoveryIndex(base, signal), started = performance.now();
  const activeIds = base.data.filter(row => row.status?.type === "active").map(row => row.id);
  if (activeIds.length > 128) return null;
  const request = async (query: unknown): Promise<Page> => {
    signal?.throwIfAborted();
    const page = await read(typeof query === "string" ? query : CATALOG_MERKLE_CURSOR + JSON.stringify(query));
    signal?.throwIfAborted(); return page as Page;
  };
  let head: Page;
  head = await request({ root: basis.hash, activeIds });
  const info = head.catalogMerkle, snapshot = parseThreadCatalogSnapshot(head);
  if (!info || info.version !== 1 || !snapshot || threadDirectoryIncomplete(head) || !/^[0-9a-f]{64}$/.test(info.root)) return null;
  const complete = (root: CatalogMerkleNode, template: Page): ThreadListResponse => {
    // Metadata equality does not certify transient execution status. Refresh the
    // bounded active set and formerly active rows through the ordinary projector.
    const leaves = catalogMerkle.leaves(root);
    for (const row of head.data) {
      const old = leaves[catalogMerkle.bucket(row.id)]!.rows!.find(r => r.id === row.id);
      if (old) root = catalogMerkle.set(root, row.id, { ...old, status: row.status });
    }
    const data = catalogMerkle.leaves(root).flatMap(n => n.rows!).sort((a, b) =>
      (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    indexes.set(data, Promise.resolve(root));
    const result = { ...template, data, nextCursor: null, catalogDecorations: head.catalogDecorations } as ThreadListResponse;
    // This extension describes wire rows only; do not reapply it to reconstructed data.
    delete (result as Page).catalogMerkle;
    return result;
  };
  if (info.mode === "equal") return info.root === basis.hash && info.count === basis.count ? complete(basis, head) : null;
  if (info.mode !== "compare" || !Array.isArray(info.leaves) || info.leaves.length !== 256
    || info.leaves.some(v => typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))) return null;
  const local = catalogMerkle.leaves(basis), buckets = info.leaves.flatMap((hash, i) => hash === local[i]!.hash ? [] : [i]);
  if (buckets.length > 128) return null;
  const rows: ThreadListResponse["data"] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = CATALOG_MERKLE_CURSOR + JSON.stringify({ id: snapshot.id, buckets });
  let last = head;
  while (cursor !== null) {
    if (performance.now() - started > 10000 || cursors.has(cursor) || cursors.size >= 512) return null;
    cursors.add(cursor);
    const page = await request(cursor), metadata = page.catalogMerkle;
    if (metadata?.mode !== "rows" || metadata.root !== info.root || metadata.count !== info.count
      || JSON.stringify(parseThreadCatalogSnapshot(page)) !== JSON.stringify(snapshot) || threadDirectoryIncomplete(page)) return null;
    for (const row of page.data) {
      if (seen.has(row.id) || !buckets.includes(catalogMerkle.bucket(row.id)) || rows.length >= 20000) return null;
      seen.add(row.id); rows.push(row);
    }
    cursor = page.nextCursor; last = page;
  }
  const restored = catalogMerkle.replace(basis, buckets, rows);
  return restored.hash === info.root && restored.count === info.count ? complete(restored, last) : null;
}
