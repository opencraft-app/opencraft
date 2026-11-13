import type { Thread } from "./generated/v2";

export const CATALOG_MERKLE_CURSOR = "opencraft-catalog-snapshot-v1:merkle:";
export const THREAD_DIRECTORY_MERKLE = "opencraft/thread-directory-merkle";
export function isCatalogSnapshotHead(cursor: unknown): boolean {
  if (cursor === "opencraft-catalog-snapshot-v1:start") return true;
  if (typeof cursor !== "string" || !cursor.startsWith(CATALOG_MERKLE_CURSOR) || cursor.length > 16384) return false;
  try { const query = JSON.parse(cursor.slice(CATALOG_MERKLE_CURSOR.length)); return !!query && typeof query.root === "string" && query.id === undefined; }
  catch { return false; }
}
export interface CatalogMerkleNode {
  readonly hash: string;
  readonly count: number;
  readonly children?: readonly CatalogMerkleNode[];
  readonly rows?: readonly Thread[];
  readonly active?: readonly Thread[];
}
export interface CatalogMerkleReply {
  version: 1;
  mode: "equal" | "compare" | "rows" | "fallback";
  root: string;
  count: number;
  leaves?: readonly string[];
}

/** Self-contained portable implementation, also embedded into the SQL reader worker.
 * SHA-256 is a content checksum, never an authorization or signature primitive.
 * Stable ID buckets have no dependency on list order or insertion history.
 */
export function createCatalogMerkle() {
  const encoder = new TextEncoder();
  const constants: number[] = [], initial: number[] = [];
  for (let p = 2; constants.length < 64; p++) {
    let prime = true;
    for (let d = 2; d * d <= p; d++) if (p % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (initial.length < 8) initial.push((Math.sqrt(p) % 1 * 0x100000000) | 0);
    constants.push((Math.cbrt(p) % 1 * 0x100000000) | 0);
  }
  function hash(text: string): string {
    const bytes = encoder.encode(text), size = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(size); data.set(bytes); data[bytes.length] = 128;
    const view = new DataView(data.buffer);
    view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(size - 4, bytes.length * 8);
    const state = initial.slice(), w = new Int32Array(64);
    const rotate = (x: number, n: number) => x >>> n | x << (32 - n);
    for (let at = 0; at < size; at += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getInt32(at + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15]!, b = w[i - 2]!;
        w[i] = (w[i - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3)
          + w[i - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10)) | 0;
      }
      let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i]! + w[i]!) | 0;
        const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => { state[i] = (state[i]! + v) | 0; });
    }
    return state.map(v => (v >>> 0).toString(16).padStart(8, "0")).join("");
  }
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return "[" + value.map(v => canonical(v ?? null)).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort()
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
    return JSON.stringify(value) ?? "null";
  }
  // Execution status and local pin/creation decorations have independent owners.
  const fields = ["id", "sessionId", "forkedFromId", "parentThreadId", "section", "sectionEnteredAt", "projectId", "nativeProject", "historyMode", "modelProvider", "model", "reasoningEffort", "createdAt", "updatedAt", "recencyAt", "path", "cwd", "cliVersion", "originator", "source", "canAcceptDirectInput", "threadSource", "agentNickname", "agentRole", "gitInfo", "daybreakEnabled", "visibility", "accessMode", "name", "preview"];
  function metadata(row: Thread): Record<string, unknown> {
    const value = row as unknown as Record<string, unknown>;
    return Object.fromEntries(fields.filter(k => value[k] != null).map(k => [k, value[k]]));
  }
  const bucket = (id: string): number => parseInt(hash(id).slice(0, 2), 16);
  function leaf(rows: readonly Thread[]): CatalogMerkleNode {
    const sorted = [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { hash: hash("catalog-leaf-v1:" + canonical(sorted.map(metadata))), count: sorted.length, rows: sorted,
      active: sorted.filter(row => row.status?.type === "active") };
  }
  function branch(children: readonly CatalogMerkleNode[]): CatalogMerkleNode {
    return { hash: hash("catalog-branch-v1:" + children.map(c => c.hash).join("")),
      count: children.reduce((n, c) => n + c.count, 0), children, active: children.flatMap(c => c.active ?? []) };
  }
  const emptyLeaf = leaf([]), emptyBranch = branch(Array(16).fill(emptyLeaf));
  const empty = branch(Array(16).fill(emptyBranch));
  const leaves = (root: CatalogMerkleNode): readonly CatalogMerkleNode[] => root.children!.flatMap(c => c.children!);
  function build(rows: readonly Thread[]): CatalogMerkleNode {
    const buckets: Thread[][] = Array.from({ length: 256 }, () => []);
    for (const row of rows) buckets[bucket(row.id)]!.push(row);
    const nodes = buckets.map(rows => rows.length ? leaf(rows) : emptyLeaf);
    return branch(Array.from({ length: 16 }, (_, i) => branch(nodes.slice(i * 16, i * 16 + 16))));
  }
  async function buildAsync(rows: readonly Thread[], yieldWork: () => Promise<void>): Promise<CatalogMerkleNode> {
    const buckets: Thread[][] = Array.from({ length: 256 }, () => []);
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at]!; buckets[bucket(row.id)]!.push(row);
      if (at % 128 === 127) await yieldWork();
    }
    const nodes: CatalogMerkleNode[] = [];
    for (let at = 0; at < 256; at++) {
      nodes.push(buckets[at]!.length ? leaf(buckets[at]!) : emptyLeaf);
      if (at % 8 === 7) await yieldWork();
    }
    return branch(Array.from({ length: 16 }, (_, i) => branch(nodes.slice(i * 16, i * 16 + 16))));
  }
  function set(root: CatalogMerkleNode, id: string, row?: Thread): CatalogMerkleNode {
    const position = bucket(id), high = position >>> 4, low = position & 15;
    const children = root.children!.slice(), children2 = children[high]!.children!.slice();
    const values = children2[low]!.rows!.filter(v => v.id !== id);
    if (row) values.push(row);
    children2[low] = leaf(values); children[high] = branch(children2); return branch(children);
  }
  function combine(roots: readonly CatalogMerkleNode[], previous?: CatalogMerkleNode): CatalogMerkleNode {
    if (roots.length === 1) return roots[0]!;
    const source = roots.map(leaves), old = previous ? leaves(previous) : undefined;
    const combined = Array.from({ length: 256 }, (_, i) => {
      const inputs = source.map(nodes => nodes[i]!);
      const prior = old?.[i] as (CatalogMerkleNode & { inputs?: readonly CatalogMerkleNode[] }) | undefined;
      if (prior?.inputs?.length === inputs.length && prior.inputs.every((node, n) => node === inputs[n])) return prior;
      const values = source.flatMap(nodes => nodes[i]!.rows!);
      return { ...leaf(values), inputs };
    });
    return branch(Array.from({ length: 16 }, (_, i) => branch(combined.slice(i * 16, i * 16 + 16))));
  }
  function replace(root: CatalogMerkleNode, buckets: readonly number[], rows: readonly Thread[]): CatalogMerkleNode {
    const groups = new Map(buckets.map(b => [b, [] as Thread[]]));
    for (const row of rows) {
      const group = groups.get(bucket(row.id));
      if (!group) throw new Error("Unexpected catalog bucket");
      group.push(row);
    }
    const nodes = [...leaves(root)];
    for (const [b, values] of groups) nodes[b] = leaf(values);
    return branch(Array.from({ length: 16 }, (_, i) => branch(nodes.slice(i * 16, i * 16 + 16))));
  }
  return { hash, canonical, metadata, bucket, empty, build, buildAsync, set, leaves, combine, replace };
}

export const catalogMerkle = createCatalogMerkle();
