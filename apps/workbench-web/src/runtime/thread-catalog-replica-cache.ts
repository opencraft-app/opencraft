import { catalogMerkle, parseThreadCatalogSnapshot, threadCatalogEntry } from "@opencraft/appserver-protocol";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import type { ClientResourceDefinition, RemoteClientResource } from "@opencraft/document-storage/client-resources";
import type { DocumentValue } from "@opencraft/document-storage";
import { canReconcileCatalog, catalogRecoveryIndex } from "./thread-catalog-recovery";

// Eight bounded remote resources share the existing account namespace and logout
// revocation. A mixed/evicted generation is never accepted as a complete baseline.
export const CATALOG_REPLICA_PARTS = 8;
type Part = { generation: string; part: number; snapshot: DocumentValue; rows: DocumentValue[] };
export const catalogReplicaResource: ClientResourceDefinition<Part> = {
  name: "thread-catalog-replica", authority: "remote", version: 1,
  parse(value) {
    const p = value as Part;
    if (!p || typeof p !== "object" || !/^[0-9a-f]{64}$/.test(p.generation) || !Number.isSafeInteger(p.part)
      || p.part < 0 || p.part >= CATALOG_REPLICA_PARTS || !Array.isArray(p.rows) || p.rows.length > 20000
      || !parseThreadCatalogSnapshot({ catalogSnapshot: p.snapshot }) || JSON.stringify(p).length > 900000) throw new Error("Invalid catalog replica part");
    const seen = new Set<string>();
    for (const row of p.rows) {
      const parsed = threadCatalogEntry(row);
      if (!parsed || seen.has(parsed.id) || catalogMerkle.bucket(parsed.id) % CATALOG_REPLICA_PARTS !== p.part) throw new Error("Invalid catalog replica row");
      seen.add(parsed.id);
    }
    return p;
  },
};
export function restoreCatalogReplica(resources: readonly RemoteClientResource<Part>[]): ThreadListResponse | undefined {
  const parts = resources.map(r => r.getSnapshot().value), first = parts[0];
  if (!first || parts.length !== CATALOG_REPLICA_PARTS || parts.some((p, i) => !p || p.part !== i
    || p.generation !== first.generation || JSON.stringify(p.snapshot) !== JSON.stringify(first.snapshot))) return;
  const data = parts.flatMap(p => p!.rows.map(row => threadCatalogEntry(row)!));
  const base = { data, nextCursor: null, catalog: { state: "ready", coverage: "complete" }, catalogSnapshot: first.snapshot } as unknown as ThreadListResponse;
  return canReconcileCatalog(base) ? base : undefined;
}
export async function saveCatalogReplica(resources: readonly RemoteClientResource<Part>[], base: ThreadListResponse,
  fence: { isCurrent(): boolean }): Promise<void> {
  if (!canReconcileCatalog(base) || !fence.isCurrent()) return;
  const root = await catalogRecoveryIndex(base);
  if (!fence.isCurrent()) return;
  if (resources.every(r => r.getSnapshot().value?.generation === root.hash
    && JSON.stringify(r.getSnapshot().value?.snapshot) === JSON.stringify(parseThreadCatalogSnapshot(base)))) return;
  const parts: Part[] = Array.from({ length: CATALOG_REPLICA_PARTS }, (_, part) => ({ generation: root.hash, part,
    snapshot: JSON.parse(JSON.stringify(parseThreadCatalogSnapshot(base))) as DocumentValue, rows: [] }));
  for (const row of base.data) parts[catalogMerkle.bucket(row.id) % CATALOG_REPLICA_PARTS]!.rows.push(catalogMerkle.metadata(row) as DocumentValue);
  // Keep below the existing 1 MiB resource limit including UTF-8 encoding.
  if (parts.some(p => new TextEncoder().encode(JSON.stringify(p)).length > 900000)) return;
  await Promise.all(parts.map((p, i) => resources[i]!.observe(p, fence)));
}
