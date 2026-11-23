import { open, readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createZstdDecompress } from "node:zlib";

type RecordValue = Record<string, any>;
interface Boundary { thread_id: string; end_byte_offset: number; end_ordinal_exclusive: number }
export interface CodexHistoryRange {
  path: string; owner: string; startOrdinal: number; checkOrdinals: boolean;
  end: number; endOrdinal?: number; bounded: boolean; compressed?: boolean; stamp: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export async function containedNativeHistoryPath(home: string, path: string): Promise<string> {
  const root = await realpath(home), source = await realpath(path), child = relative(root, source);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("Native history source outside configured home");
  return source;
}
const isCompressedRollout = (path: string) => path.endsWith(".jsonl.zst");
const nodeId = (path: string) => basename(path).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/u)?.[1];
function dedupeRolloutPaths(paths: readonly string[]): string[] {
  const set = new Set(paths);
  return paths.filter(path => !(isCompressedRollout(path) && set.has(path.slice(0, -4))));
}
async function containedRolloutPath(home: string, candidate: string): Promise<string> {
  try {
    return await containedNativeHistoryPath(home, candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && candidate.endsWith(".jsonl")) {
      return containedNativeHistoryPath(home, `${candidate}.zst`);
    }
    throw error;
  }
}

interface CachedMetadata {
  owner: string;
  firstOrdinal: number;
  checkOrdinals: boolean;
  base: Boundary | null;
  attached: boolean;
}
export interface CodexHistoryReadOptions {
  readonly relevantEventsOnly?: boolean;
  readonly outlineOnly?: boolean;
  readonly goalEventsOnly?: boolean;
}
const HEADER_LIMIT = 384;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const GOAL_NEEDLE = Buffer.from("goal");
const RELEVANT_CODEX_EVENTS = new Set([
  "task_started",
  "item_completed",
  "user_message",
  "agent_message",
  "agent_reasoning",
  "task_complete",
  "turn_aborted",
  "thread_rolled_back",
]);
const CANONICAL_HEADER = /^\{(?:"timestamp":"[^"\\\x00-\x1f]*",)?(?:"ordinal":(\d+),)?"type":"([a-z_]+)",/u;
const EVENT_HEADER = /^\{(?:"timestamp":"[^"\\\x00-\x1f]*",)?(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"([a-z_]+)"/u;
const OUTLINE_ITEM_HEADER = /^\{(?:"timestamp":"[^"\\\x00-\x1f]*",)?(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"item_completed",(?:"thread_id":"[^"\\\x00-\x1f]*",)?"turn_id":"([^"\\\x00-\x1f]+)","item":\{"type":"([A-Za-z_]+)"/u;

/** Read-only Codex source resolution. Instantiate only in the history Worker. */
export class CodexHistorySources {
  private readonly nodes = new Map<string, string>();
  private readonly metaCache = new Map<string, { stamp: string; value: CachedMetadata }>();
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
  private async metadata(path: string, sourceStat?: Awaited<ReturnType<typeof stat>>): Promise<CachedMetadata> {
    const source = sourceStat ?? await stat(path);
    const stamp = `${source.dev}:${source.ino}:${source.size}:${source.mtimeMs}`;
    const cached = this.metaCache.get(path);
    if (cached?.stamp === stamp) return cached.value;
    const file = await open(path, "r");
    const stream = file.createReadStream({ autoClose: false, highWaterMark: 16 * 1024 });
    const zstd = isCompressedRollout(path) ? createZstdDecompress({ chunkSize: 16 * 1024 }) : null;
    if (zstd) {
      stream.on("error", error => zstd.destroy(error));
      stream.pipe(zstd);
    }
    const lines = createInterface({ input: zstd ?? stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("Native history metadata too large");
        const record: RecordValue = JSON.parse(line), meta = record.payload;
        if (record.type !== "session_meta" || !meta || !uuid.test(meta.id ?? meta.session_id ?? "")) throw new Error("Native history metadata identity missing".replace(" metadata", ""));
        if (meta.id && meta.session_id && meta.id !== meta.session_id) throw new Error("Native history identity mismatch");
        const base = meta.history_base;
        if (base != null && (!uuid.test(base.thread_id ?? "") || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset <= 0 || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive <= 0)) throw new Error("Invalid native history boundary");
        const firstOrdinal = base?.end_ordinal_exclusive ?? 0;
        if (record.ordinal !== undefined && record.ordinal !== firstOrdinal) throw new Error("Native history ordinal mismatch");
        // Attached agents' inherited prompt context is not their visible chat.
        const attached = meta.attached_thread === true && (meta.forked_from_ordinal_exclusive == null || base?.end_ordinal_exclusive <= meta.forked_from_ordinal_exclusive);
        const value: CachedMetadata = { owner: meta.id ?? meta.session_id, firstOrdinal, checkOrdinals: record.ordinal !== undefined, base: base ?? null, attached };
        this.metaCache.set(path, { stamp, value });
        if (this.metaCache.size > 512) this.metaCache.delete(this.metaCache.keys().next().value!);
        return value;
      }
      throw new Error("Native history metadata missing");
    } finally {
      lines.close();
      if (zstd) { stream.unpipe(zstd); zstd.on("error", () => {}); zstd.destroy(); }
      stream.on("error", () => {});
      stream.destroy();
      await file.close();
    }
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
        return containedRolloutPath(this.home, row.rollout_path);
      } finally { db.close(); }
    }
    return null;
  }
  async resolve(id: string): Promise<CodexHistoryRange[]> {
    if (!uuid.test(id)) throw new Error("Invalid native conversation identity");
    let files: string[] | undefined;
    const scan = async () => files ??= dedupeRolloutPaths(await this.files());
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
      if (tips.length === 0) throw Object.assign(new Error("Native history head is missing"), { code: "NATIVE_HISTORY_NOT_FOUND" });
      if (tips.length !== 1) throw new Error("Native history head is ambiguous");
      head = tips[0]!.path;
    }
    const result: CodexHistoryRange[] = [], seen = new Set<string>();
    let current = head, boundary: Boundary | undefined;
    while (current) {
      const path = await containedRolloutPath(this.home, current), physicalId = nodeId(path);
      if (!physicalId || seen.has(physicalId) || seen.size >= 64) throw new Error("Invalid native history ancestry");
      seen.add(physicalId);
      const source = await stat(path), meta = await this.metadata(path, source), compressed = isCompressedRollout(path);
      if (!result.length && meta.owner !== id) throw new Error("Native history head identity mismatch");
      if (boundary && physicalId !== boundary.thread_id) throw new Error("Native history ancestor identity mismatch");
      if (boundary && boundary.end_ordinal_exclusive < meta.firstOrdinal) throw new Error("Native history boundary exceeds source");
      const end = boundary?.end_byte_offset ?? source.size;
      if (!compressed) {
        if (end > source.size) throw new Error("Native history boundary exceeds source");
        if (boundary) {
          const handle = await open(path, "r");
          try { const last = Buffer.alloc(1); await handle.read(last, 0, 1, end - 1); if (last[0] !== 10) throw new Error("Native history boundary splits a record"); }
          finally { await handle.close(); }
        }
      }
      result.push({ path, owner: meta.owner, startOrdinal: meta.firstOrdinal, checkOrdinals: meta.checkOrdinals,
        end, ...(boundary ? { endOrdinal: boundary.end_ordinal_exclusive } : {}), bounded: !!boundary,
        ...(compressed ? { compressed: true } : {}),
        stamp: JSON.stringify([path, source.dev, source.ino, source.size, source.mtimeMs, boundary ?? null]) });
      if (!meta.base || meta.attached) break;
      boundary = meta.base;
      const known = this.nodes.get(boundary.thread_id);
      const resolvedKnown = known ? await containedRolloutPath(this.home, known).catch(() => null) : null;
      if (resolvedKnown) { current = resolvedKnown; this.nodes.set(boundary.thread_id, resolvedKnown); }
      else {
        const candidates = dedupeRolloutPaths((await scan()).filter(path => nodeId(path) === boundary!.thread_id));
        if (candidates.length !== 1) throw new Error("Native history ancestor is missing or ambiguous");
        current = candidates[0]!; this.nodes.set(boundary.thread_id, current);
      }
    }
    return result.reverse();
  }
}

type LineDecision = "undecided" | "parse" | "skip" | { readonly outline: RecordValue };

function classifyCodexHeader(
  prefix: string,
  fullLine: boolean,
  checkOrdinals: boolean,
  expectedOrdinal: number,
  options: CodexHistoryReadOptions | undefined,
): LineDecision {
  if (!options?.relevantEventsOnly) return "parse";
  const header = CANONICAL_HEADER.exec(prefix);
  if (!header) return !fullLine && prefix.length < HEADER_LIMIT ? "undecided" : "parse";
  if (checkOrdinals) {
    if (header[1] === undefined) return "parse";
    if (Number(header[1]) !== expectedOrdinal) throw new Error("Native history ordinal mismatch");
  }
  const recordType = header[2]!;
  if (recordType !== "event_msg") return "skip";
  const eventHeader = EVENT_HEADER.exec(prefix);
  if (!eventHeader) return !fullLine && prefix.length < HEADER_LIMIT ? "undecided" : "parse";
  const eventType = eventHeader[1]!;
  if (!RELEVANT_CODEX_EVENTS.has(eventType)) return "skip";
  if (options.outlineOnly && eventType === "item_completed" && !fullLine) {
    const outlineMatch = OUTLINE_ITEM_HEADER.exec(prefix);
    if (outlineMatch) {
      return {
        outline: {
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: outlineMatch[1]!,
            item: { id: "outline", type: outlineMatch[2]! },
          },
        },
      };
    }
  }
  return "parse";
}

/** Byte-bounded complete records; a branch cutoff must match both offsets. */
export async function* codexHistoryRecords(
  ranges: readonly CodexHistoryRange[],
  options?: CodexHistoryReadOptions,
): AsyncGenerator<RecordValue> {
  for (const range of ranges) {
    const file = await open(range.path, "r");
    const stream = file.createReadStream(range.compressed
      ? { autoClose: false, highWaterMark: STREAM_CHUNK_BYTES }
      : { autoClose: false, start: 0, end: range.end - 1, highWaterMark: STREAM_CHUNK_BYTES });
    const zstd = range.compressed ? createZstdDecompress({ chunkSize: STREAM_CHUNK_BYTES }) : null;
    if (zstd) {
      stream.on("error", error => zstd.destroy(error));
      stream.pipe(zstd);
    }
    const lineChunks: Buffer[] = [];
    let lineBytes = 0, header = "", lineAction: LineDecision = "undecided";
    let ordinal = range.startOrdinal, verified = false, decompressedBytes = 0;
    try {
      for await (const rawChunk of zstd ?? stream) {
        let chunk: Buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        if (range.compressed && range.bounded) {
          const remaining = range.end - decompressedBytes;
          if (remaining <= 0) break;
          if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
          decompressedBytes += chunk.length;
        }
        let pos = 0;
        while (pos < chunk.length) {
          const newline = chunk.indexOf(10, pos);
          if (newline < 0) {
            const part = chunk.subarray(pos);
            lineBytes += part.length;
            if (lineBytes > 64 * 1024 * 1024) throw new Error("Native history record too large");
            if (lineAction === "undecided") {
              if (!verified || !options?.relevantEventsOnly) {
                lineAction = "parse";
              } else {
                if (header.length < HEADER_LIMIT) {
                  header += part.subarray(0, Math.min(part.length, HEADER_LIMIT - header.length)).toString("latin1");
                }
                if (header.length >= HEADER_LIMIT) {
                  lineAction = classifyCodexHeader(header, false, range.checkOrdinals, ordinal, options);
                }
              }
            }
            if (lineAction === "parse" || lineAction === "undecided") {
              lineChunks.push(part);
            } else {
              lineChunks.length = 0;
            }
            break;
          }
          const part = chunk.subarray(pos, newline);
          pos = newline + 1;
          const totalBytes = lineBytes + part.length;
          if (totalBytes > 64 * 1024 * 1024) throw new Error("Native history record too large");
          let action = lineAction;
          if (action === "undecided") {
            if (!verified || !options?.relevantEventsOnly) {
              action = "parse";
            } else {
              const fullHeader = lineBytes === 0
                ? part.subarray(0, Math.min(part.length, HEADER_LIMIT)).toString("latin1")
                : header.length < HEADER_LIMIT
                  ? header + part.subarray(0, Math.min(part.length, HEADER_LIMIT - header.length)).toString("latin1")
                  : header;
              const treatAsFullLine = !(options.outlineOnly && totalBytes > 4096);
              action = classifyCodexHeader(fullHeader, treatAsFullLine, range.checkOrdinals, ordinal, options);
              if (action === "undecided") action = "parse";
            }
          }
          lineBytes = 0;
          header = "";
          lineAction = "undecided";
          if (action === "skip") {
            lineChunks.length = 0;
            ordinal++;
            continue;
          }
          if (typeof action === "object") {
            lineChunks.length = 0;
            ordinal++;
            yield action.outline;
            continue;
          }
          const bytes = lineChunks.length === 0
            ? part
            : (lineChunks.push(part), Buffer.concat(lineChunks, totalBytes));
          lineChunks.length = 0;
          if (verified && options?.goalEventsOnly && !range.checkOrdinals && !bytes.includes(GOAL_NEEDLE)) {
            ordinal++;
            continue;
          }
          if (verified && options?.goalEventsOnly && range.checkOrdinals && !bytes.includes(GOAL_NEEDLE)) {
            const ordMatch = CANONICAL_HEADER.exec(bytes.subarray(0, Math.min(bytes.length, 160)).toString("latin1"));
            if (ordMatch && ordMatch[1] !== undefined) {
              if (Number(ordMatch[1]) !== ordinal) throw new Error("Native history ordinal mismatch");
              ordinal++;
              continue;
            }
          }
          const record: RecordValue = JSON.parse(bytes.toString("utf8"));
          if (range.checkOrdinals && record.ordinal !== ordinal) throw new Error("Native history ordinal mismatch");
          if (!verified) {
            if (record.type !== "session_meta" || (record.payload?.id ?? record.payload?.session_id) !== range.owner) throw new Error("Native history identity mismatch");
            verified = true;
          }
          ordinal++;
          yield record;
        }
        if (range.compressed && range.bounded && decompressedBytes >= range.end) {
          if (lineBytes > 0) throw new Error("Native history boundary splits a record");
          break;
        }
      }
      if (range.compressed && range.bounded && decompressedBytes < range.end) throw new Error("Native history boundary exceeds source");
      if (!verified || range.bounded && (lineBytes > 0 || ordinal !== range.endOrdinal)) throw new Error("Incomplete native history boundary");
    } finally {
      if (zstd) { stream.unpipe(zstd); zstd.on("error", () => {}); zstd.destroy(); }
      stream.on("error", () => {});
      stream.destroy();
      await file.close();
    }
  }
}
