import { open, readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

type RecordValue = Record<string, any>;
interface Boundary { thread_id: string; end_byte_offset: number; end_ordinal_exclusive: number }
export interface CodexHistoryRange {
  path: string; owner: string; startOrdinal: number; checkOrdinals: boolean;
  end: number; endOrdinal?: number; bounded: boolean; stamp: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export async function containedNativeHistoryPath(home: string, path: string): Promise<string> {
  const root = await realpath(home), source = await realpath(path), child = relative(root, source);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("Native history source outside configured home");
  return source;
}
const nodeId = (path: string) => basename(path).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/u)?.[1];

/** Read-only Codex source resolution. Instantiate only in the history Worker. */
export class CodexHistorySources {
  private readonly nodes = new Map<string, string>();
  constructor(private readonly home: string) {}
  private async files(): Promise<string[]> {
    const found: string[] = [];
    const visit = async (directory: string, depth: number) => {
      if (depth > 16) throw new Error("Native history directory depth exceeded");
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && nodeId(path)) { found.push(path); if (found.length > 100000) throw new Error("Native history directory too large"); }
      }
    };
    for (const root of ["sessions", "archived_sessions"]) await visit(join(this.home, root), 0);
    return found;
  }
  private async metadata(path: string): Promise<{ owner: string; firstOrdinal: number; checkOrdinals: boolean; base: Boundary | null; attached: boolean }> {
    const file = await open(path, "r");
    const stream = file.createReadStream({ autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("Native history metadata too large");
        const record: RecordValue = JSON.parse(line), meta = record.payload;
        if (record.type !== "session_meta" || !meta || !uuid.test(meta.id ?? meta.session_id ?? "")) throw new Error("Native history identity missing");
        if (meta.id && meta.session_id && meta.id !== meta.session_id) throw new Error("Native history identity mismatch");
        const base = meta.history_base;
        if (base != null && (!uuid.test(base.thread_id ?? "") || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset <= 0 || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive <= 0)) throw new Error("Invalid native history boundary");
        const firstOrdinal = base?.end_ordinal_exclusive ?? 0;
        if (record.ordinal !== undefined && record.ordinal !== firstOrdinal) throw new Error("Native history ordinal mismatch");
        // Attached agents' inherited prompt context is not their visible chat.
        const attached = meta.attached_thread === true && (meta.forked_from_ordinal_exclusive == null || base?.end_ordinal_exclusive <= meta.forked_from_ordinal_exclusive);
        return { owner: meta.id ?? meta.session_id, firstOrdinal, checkOrdinals: record.ordinal !== undefined, base: base ?? null, attached };
      }
      throw new Error("Native history metadata missing");
    } finally { lines.close(); stream.destroy(); await file.close(); }
  }
  private async indexedHead(id: string): Promise<string | null> {
    const entries = await readdir(this.home, { withFileTypes: true });
    const indexes = entries.filter(e => e.isFile() && /^state_\d+\.sqlite$/u.test(e.name)).sort((a, b) => Number(b.name.match(/\d+/u)![0]) - Number(a.name.match(/\d+/u)![0]));
    for (const entry of indexes) {
      const path = await containedNativeHistoryPath(this.home, join(this.home, entry.name));
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const row = db.prepare("SELECT rollout_path FROM threads WHERE id=?").get(id) as { rollout_path: unknown } | undefined;
        if (!row) continue;
        if (typeof row.rollout_path !== "string" || !isAbsolute(row.rollout_path)) throw new Error("Invalid native history head");
        return containedNativeHistoryPath(this.home, row.rollout_path);
      } finally { db.close(); }
    }
    return null;
  }
  async resolve(id: string): Promise<CodexHistoryRange[]> {
    if (!uuid.test(id)) throw new Error("Invalid native conversation identity");
    let files: string[] | undefined;
    const scan = async () => files ??= await this.files();
    let head = await this.indexedHead(id);
    if (!head) {
      const candidates = (await scan()).filter(path => basename(path).includes(id));
      const matching: { path: string; base: Boundary | null }[] = [];
      for (const path of candidates) {
        const meta = await this.metadata(await containedNativeHistoryPath(this.home, path));
        if (meta.owner === id) matching.push({ path, base: meta.base });
      }
      const ancestors = new Set(matching.map(row => row.base?.thread_id));
      const tips = matching.filter(row => !ancestors.has(nodeId(row.path)));
      if (tips.length !== 1) throw new Error("Native history head is missing or ambiguous");
      head = tips[0]!.path;
    }
    const result: CodexHistoryRange[] = [], seen = new Set<string>();
    let current = head, boundary: Boundary | undefined;
    while (current) {
      const path = await containedNativeHistoryPath(this.home, current), physicalId = nodeId(path);
      if (!physicalId || seen.has(physicalId) || seen.size >= 64) throw new Error("Invalid native history ancestry");
      seen.add(physicalId);
      const meta = await this.metadata(path), source = await stat(path);
      if (!result.length && meta.owner !== id) throw new Error("Native history head identity mismatch");
      if (boundary && physicalId !== boundary.thread_id) throw new Error("Native history ancestor identity mismatch");
      const end = boundary?.end_byte_offset ?? source.size;
      if (end > source.size || boundary && boundary.end_ordinal_exclusive < meta.firstOrdinal) throw new Error("Native history boundary exceeds source");
      if (boundary) {
        const handle = await open(path, "r");
        try { const last = Buffer.alloc(1); await handle.read(last, 0, 1, end - 1); if (last[0] !== 10) throw new Error("Native history boundary splits a record"); }
        finally { await handle.close(); }
      }
      result.push({ path, owner: meta.owner, startOrdinal: meta.firstOrdinal, checkOrdinals: meta.checkOrdinals,
        end, ...(boundary ? { endOrdinal: boundary.end_ordinal_exclusive } : {}), bounded: !!boundary,
        stamp: JSON.stringify([path, source.dev, source.ino, source.size, source.mtimeMs, boundary ?? null]) });
      if (!meta.base || meta.attached) break;
      boundary = meta.base;
      const known = this.nodes.get(boundary.thread_id);
      if (known && await stat(known).then(() => true, () => false)) current = known;
      else {
        const candidates = (await scan()).filter(path => nodeId(path) === boundary!.thread_id);
        if (candidates.length !== 1) throw new Error("Native history ancestor is missing or ambiguous");
        current = candidates[0]!; this.nodes.set(boundary.thread_id, current);
      }
    }
    return result.reverse();
  }
}

/** Byte-bounded complete records; a branch cutoff must match both offsets. */
export async function* codexHistoryRecords(ranges: readonly CodexHistoryRange[]): AsyncGenerator<RecordValue> {
  for (const range of ranges) {
    const file = await open(range.path, "r"), stream = file.createReadStream({ autoClose: false, start: 0, end: range.end - 1 });
    let pending = Buffer.alloc(0), ordinal = range.startOrdinal, verified = false;
    try {
      for await (const chunk of stream) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let start = 0, newline: number;
        while ((newline = pending.indexOf(10, start)) >= 0) {
          const bytes = pending.subarray(start, newline); start = newline + 1;
          if (bytes.length > 64 * 1024 * 1024) throw new Error("Native history record too large");
          const record: RecordValue = JSON.parse(bytes.toString("utf8"));
          if (range.checkOrdinals && record.ordinal !== ordinal) throw new Error("Native history ordinal mismatch");
          if (!verified) {
            if (record.type !== "session_meta" || (record.payload?.id ?? record.payload?.session_id) !== range.owner) throw new Error("Native history identity mismatch");
            verified = true;
          }
          ordinal++; yield record;
        }
        pending = pending.subarray(start);
        if (pending.length > 64 * 1024 * 1024) throw new Error("Native history record too large");
      }
      if (!verified || range.bounded && (pending.length || ordinal !== range.endOrdinal)) throw new Error("Incomplete native history boundary");
    } finally { stream.destroy(); await file.close(); }
  }
}
