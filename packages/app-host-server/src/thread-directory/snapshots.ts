import { randomUUID } from "node:crypto";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
import { CATALOG_SNAPSHOT_EXPIRED, CATALOG_MERKLE_CURSOR, catalogMerkle, createCatalogMerklePager, type CatalogMerkleNode, type ThreadCatalogCheckpoint } from "@opencraft/appserver-protocol";

export const SNAPSHOT_CURSOR = "opencraft-catalog-snapshot-v1:";
export const SNAPSHOT_START = SNAPSHOT_CURSOR + "start";
type Key = readonly [number, string];
type Node = Readonly<{ row: Thread; key: Key; left: Node | null; right: Node | null; height: number }>;
const height = (n: Node | null): number => n?.height ?? 0;
const key = (row: Thread): Key => [row.recencyAt ?? row.updatedAt ?? 0, row.id];
const compare = (a: Key, b: Key): number => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const node = (row: Thread, left: Node | null, right: Node | null): Node => ({ row, key: key(row), left, right, height: 1 + Math.max(height(left), height(right)) });
function balance(row: Thread, left: Node | null, right: Node | null): Node {
  if (height(left) - height(right) > 1) {
    let l = left!;
    if (height(l.right) > height(l.left)) {
      const p = l.right!; l = node(p.row, node(l.row, l.left, p.left), p.right);
    }
    return node(l.row, l.left, node(row, l.right, right));
  }
  if (height(right) - height(left) > 1) {
    let r = right!;
    if (height(r.left) > height(r.right)) {
      const p = r.left!; r = node(p.row, p.left, node(r.row, p.right, r.right));
    }
    return node(r.row, node(row, left, r.left), r.right);
  }
  return node(row, left, right);
}
function put(root: Node | null, row: Thread): Node {
  if (!root) return node(row, null, null);
  const c = compare(key(row), root.key);
  return c < 0 ? balance(root.row, put(root.left, row), root.right)
    : c > 0 ? balance(root.row, root.left, put(root.right, row)) : node(row, root.left, root.right);
}
function remove(root: Node | null, value: Key): Node | null {
  if (!root) return null;
  const c = compare(value, root.key);
  if (c < 0) return balance(root.row, remove(root.left, value), root.right);
  if (c > 0) return balance(root.row, root.left, remove(root.right, value));
  if (!root.left) return root.right;
  if (!root.right) return root.left;
  let next = root.right; while (next.left) next = next.left;
  return balance(next.row, root.left, remove(root.right, next.key));
}
function rows(root: Node | null, after: Key | null, limit: number, out: Thread[] = []): Thread[] {
  if (!root || out.length >= limit) return out;
  if (after && compare(root.key, after) <= 0) return rows(root.right, after, limit, out);
  rows(root.left, after, limit, out);
  if (out.length < limit) out.push(root.row);
  if (out.length < limit) rows(root.right, after, limit, out);
  return out;
}

/** A derived, immutable ordered index over the existing directory authority.
 * Updates copy O(log N) nodes; capturing a read never scans or copies all rows. */
export class DirectorySnapshotIndex {
  private readonly entries = new Map<string, { row: Thread; archived: boolean }>();
  private roots: [Node | null, Node | null] = [null, null];
  private merkle: [CatalogMerkleNode, CatalogMerkleNode] = [catalogMerkle.empty, catalogMerkle.empty];
  replace(entries: readonly { row: Thread; archived: boolean }[]): void {
    this.entries.clear();
    const partitions: [Thread[], Thread[]] = [[], []];
    for (const entry of entries) {
      const row = structuredClone(entry.row);
      this.entries.set(row.id, { row, archived: entry.archived }); partitions[Number(entry.archived)]!.push(row);
    }
    const build = (values: Thread[], start: number, end: number): Node | null => {
      if (start >= end) return null;
      const middle = Math.floor((start + end) / 2);
      return node(values[middle]!, build(values, start, middle), build(values, middle + 1, end));
    };
    this.roots = partitions.map(values => {
      values.sort((a, b) => compare(key(a), key(b))); return build(values, 0, values.length);
    }) as [Node | null, Node | null];
    this.merkle = partitions.map(values => catalogMerkle.build(values)) as [CatalogMerkleNode, CatalogMerkleNode];
  }
  set(row: Thread, archived: boolean): void {
    this.delete(row.id);
    const immutable = structuredClone(row);
    this.entries.set(row.id, { row: immutable, archived });
    this.roots[Number(archived)] = put(this.roots[Number(archived)]!, immutable);
    this.merkle[Number(archived)] = catalogMerkle.set(this.merkle[Number(archived)]!, immutable.id, immutable);
  }
  delete(id: string): void {
    const old = this.entries.get(id); if (!old) return;
    this.roots[Number(old.archived)] = remove(this.roots[Number(old.archived)]!, key(old.row));
    this.merkle[Number(old.archived)] = catalogMerkle.set(this.merkle[Number(old.archived)]!, id);
    this.entries.delete(id);
  }
  capture(archived: boolean): Node | null { return this.roots[Number(archived)]!; }
  captureMerkle(archived: boolean): CatalogMerkleNode { return this.merkle[Number(archived)]!; }
  captureProjectedMerkle(archived: boolean, admission: ((id: string) => boolean) & {
    catalogPolicy?: (id: string) => "shared" | "private" | undefined;
  }): CatalogMerkleNode {
    // Runs in the history reader worker, before hashing or exposing any summary.
    return catalogMerkle.build(rows(this.capture(archived), null, Number.MAX_SAFE_INTEGER)
      .filter(row => admission(row.id)).map(row => {
        const mode = admission.catalogPolicy?.(row.id);
        // Stored status is not an execution observation. The transport adds its
        // current admitted active IDs and projects their live owner statuses.
        return { ...row, ...(mode ? { accessMode: mode } : {}), status: { type: "notLoaded" } } as Thread;
      }));
  }
}
export type DirectorySnapshotPart = { root: Node | null; merkle?: CatalogMerkleNode; checkpoint: ThreadCatalogCheckpoint };
export function snapshotExpired(): Error {
  return Object.assign(new Error("Conversation catalog snapshot expired; restart from the first page"), { code: CATALOG_SNAPSHOT_EXPIRED, rpcCode: CATALOG_SNAPSHOT_EXPIRED });
}

/** Cursors are owner-bound, expiring read handles, never authorization tokens.
 * Each response still traverses the caller's existing admission/projection lane. */
export class DirectorySnapshotPages {
  private readonly merklePages;
  private mergedMerkle?: CatalogMerkleNode;
  private readonly views = new Map<string, { archived: boolean; parts: readonly DirectorySnapshotPart[]; catalog: unknown; expires: number }>();
  constructor(private readonly now = Date.now, private readonly ttl = 120_000, private readonly capacity = 16) {
    this.merklePages = new (createCatalogMerklePager(catalogMerkle))(randomUUID, now);
  }
  list(cursor: string, archived: boolean, limit: number, capture: () => { parts: readonly DirectorySnapshotPart[]; catalog: unknown }, reader?: string) {
    if (cursor.startsWith(CATALOG_MERKLE_CURSOR)) return this.merklePages.list(cursor, archived, limit, () => {
      const view = capture();
      this.mergedMerkle = catalogMerkle.combine(view.parts.map(p => p.merkle ?? catalogMerkle.build(rows(p.root, null, Number.MAX_SAFE_INTEGER))), this.mergedMerkle);
      return { root: this.mergedMerkle, catalog: view.catalog, checkpoints: view.parts.map(p => p.checkpoint) };
    }, reader);
    for (const [id, view] of this.views) if (view.expires <= this.now()) this.views.delete(id);
    let id: string, after: Key | null = null;
    if (cursor === SNAPSHOT_START) {
      id = randomUUID();
      if (this.views.size >= this.capacity) this.views.delete(this.views.keys().next().value!);
      this.views.set(id, { ...capture(), archived, expires: this.now() + this.ttl });
    } else {
      try {
        const value: unknown = JSON.parse(cursor.slice(SNAPSHOT_CURSOR.length));
        if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "string" || !Number.isFinite(value[1]) || typeof value[2] !== "string") throw Error();
        id = value[0]; after = [value[1], value[2]];
      } catch { throw snapshotExpired(); }
    }
    const view = this.views.get(id);
    if (!view || view.archived !== archived) throw snapshotExpired();
    const merged = view.parts.flatMap(part => rows(part.root, after, limit + 1));
    merged.sort((a, b) => compare(key(a), key(b)));
    const more = merged.length > limit, data = merged.slice(0, limit), last = data.at(-1);
    return { data: structuredClone(data), nextCursor: more && last ? SNAPSHOT_CURSOR + JSON.stringify([id, ...key(last)]) : null,
      backwardsCursor: null, catalog: view.catalog,
      catalogSnapshot: { version: 1 as const, id, checkpoints: view.parts.map(part => part.checkpoint) } };
  }
  clear(): void { this.views.clear(); this.merklePages.clear(); this.mergedMerkle = undefined; }
}
