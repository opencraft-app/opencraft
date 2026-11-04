import type { Thread } from "./generated/v2";
import type { CatalogMerkleNode, CatalogMerkleReply, createCatalogMerkle } from "./catalog-merkle";

export interface CatalogMerkleCapture {
  root: CatalogMerkleNode;
  catalog: unknown;
  checkpoints: readonly { source: string; revision: number }[];
}
export interface CatalogMerklePage {
  data: Thread[]; nextCursor: string | null; backwardsCursor: null; catalog: unknown;
  catalogSnapshot: { version: 1; id: string; checkpoints: readonly { source: string; revision: number }[] };
  catalogMerkle: CatalogMerkleReply;
}

/** A bounded owner-local read handle, not a capability or durable replay token. */
export function createCatalogMerklePager(tools: ReturnType<typeof createCatalogMerkle>): new (uuid: () => string, now?: () => number) => {
  clear(): void;
  list(cursor: string, archived: boolean, limit: number, capture: () => CatalogMerkleCapture, reader?: string): CatalogMerklePage;
} {
  const prefix = "opencraft-catalog-snapshot-v1:merkle:";
  return class CatalogMerklePages {
    private readonly views = new Map<string, CatalogMerkleCapture & { archived: boolean; expires: number; reader?: string }>();
    constructor(private readonly uuid: () => string, private readonly now: () => number = Date.now) {}
    clear(): void { this.views.clear(); }
    list(cursor: string, archived: boolean, limit: number, capture: () => CatalogMerkleCapture, reader?: string) {
      const expired = () => Object.assign(new Error("Catalog comparison expired"), { code: -32086, rpcCode: -32086 });
      if (cursor.length > 16384 || !cursor.startsWith(prefix) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw expired();
      let query: { id?: string; root?: string; buckets?: number[]; offset?: number; activeIds?: string[] };
      try { query = JSON.parse(cursor.slice(prefix.length)); if (!query || typeof query !== "object" || Array.isArray(query)) throw Error(); }
      catch { throw expired(); }
      for (const [id, view] of this.views) if (view.expires <= this.now()) this.views.delete(id);
      let id = query.id;
      if (id === undefined) {
        if (typeof query.root !== "string" || !/^[0-9a-f]{64}$/.test(query.root) || query.buckets !== undefined || query.offset !== undefined) throw expired();
        id = this.uuid();
        if (this.views.size >= 16) this.views.delete(this.views.keys().next().value!);
        this.views.set(id, { ...capture(), archived, reader, expires: this.now() + 120000 });
      }
      const view = this.views.get(id);
      if (!view || view.archived !== archived || view.reader !== reader) throw expired();
      const base = { data: [] as Thread[], nextCursor: null as string | null, backwardsCursor: null,
        catalog: view.catalog, catalogSnapshot: { version: 1 as const, id, checkpoints: view.checkpoints } };
      const reply: CatalogMerkleReply = { version: 1, mode: "compare", root: view.root.hash, count: view.root.count };
      const coverage = view.catalog as { coverage?: string; state?: string } | undefined;
      if (coverage?.coverage !== "complete" || coverage.state === "error") return { ...base, catalogMerkle: { ...reply, mode: "fallback" as const } };
      if (query.buckets === undefined) {
        const activeIds = query.activeIds ?? [];
        if (!Array.isArray(activeIds) || activeIds.length > 256 || activeIds.some(id => typeof id !== "string" || id.length > 4096)) throw expired();
        if (activeIds.length > 128) return { ...base, catalogMerkle: { ...reply, mode: "fallback" as const } };
        if ((view.root.active?.length ?? 0) > 128) return { ...base, catalogMerkle: { ...reply, mode: "fallback" as const } };
        const live = new Map(view.root.active?.map(row => [row.id, row]) ?? []), leaves = tools.leaves(view.root);
        for (const id of activeIds) {
          const current = leaves[tools.bucket(id)]!.rows!.find(row => row.id === id);
          if (current) live.set(id, current);
        }
        base.data = structuredClone([...live.values()]);
        if (query.root === view.root.hash) reply.mode = "equal";
        else reply.leaves = tools.leaves(view.root).map(n => n.hash);
        return { ...base, catalogMerkle: reply };
      }
      const buckets = query.buckets, offset = query.offset ?? 0;
      if (!Array.isArray(buckets) || buckets.length > 256 || new Set(buckets).size !== buckets.length
        || buckets.some(n => !Number.isSafeInteger(n) || n < 0 || n > 255)
        || !Number.isSafeInteger(offset) || offset < 0) throw expired();
      const nodes = tools.leaves(view.root);
      // Large differences use the ordinary streaming snapshot instead.
      const changed = buckets.reduce((n, b) => n + nodes[b]!.count, 0);
      if (buckets.length > 128 || changed > Math.max(64, view.root.count * 0.6))
        return { ...base, catalogMerkle: { ...reply, mode: "fallback" as const } };
      // Traverse retained ID-ordered leaves; no all-directory scan or sort per page.
      const data: Thread[] = []; let skipped = 0;
      for (const b of buckets) {
        const rows = nodes[b]!.rows!;
        if (skipped + rows.length <= offset) { skipped += rows.length; continue; }
        for (let at = Math.max(0, offset - skipped); at < rows.length && data.length < limit; at++) data.push(rows[at]!);
        skipped += rows.length;
        if (data.length >= limit) break;
      }
      const next = offset + data.length;
      return { ...base, data: structuredClone(data),
        nextCursor: next < changed ? prefix + JSON.stringify({ id, buckets, offset: next }) : null,
        catalogMerkle: { ...reply, mode: "rows" as const } };
    }
  };
}
