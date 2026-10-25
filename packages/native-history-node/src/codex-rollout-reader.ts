import { open, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

export class OversizedRolloutLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OversizedRolloutLineError";
  }
}

/** Trusted Host-side binding. RPC callers never supply a native HOME. */
export interface NativeRolloutSource {
  readonly nativeHome: string;
  readonly key: string;
  /** Reject a read whose routing owner or runtime incarnation was replaced. */
  validate(): Promise<void>;
}

export class RolloutOutsideHomeError extends Error {
  constructor() { super("Rollout source outside native home"); }
}

export async function canonicalRolloutPath(path: string, nativeHome: string): Promise<string> {
  const root = await realpath(nativeHome), canonical = await realpath(path), child = relative(root, canonical);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) throw new RolloutOutsideHomeError();
  return canonical;
}

export async function findNextNewline(
  file: import("node:fs/promises").FileHandle,
  from: number,
  limit = 64 * 1024 * 1024,
): Promise<number | null> {
  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  let offset = 0;
  while (offset < limit) {
    const toRead = Math.min(chunkSize, limit - offset);
    const { bytesRead } = await file.read(chunk, 0, toRead, from + offset);
    if (bytesRead === 0) return null;
    const nl = chunk.subarray(0, bytesRead).indexOf(10);
    if (nl !== -1) {
      return from + offset + nl + 1;
    }
    offset += bytesRead;
  }
  throw new OversizedRolloutLineError("Usage rollout line exceeds 64 MiB limit without newline");
}

export interface RolloutReadOptions<T> {
  path: string;
  nativeHome: string;
  source?: NativeRolloutSource;
  cursor: number;
  identity: string | null;
  select(head: string): boolean;
  retain(value: any, end: number): T | null;
  maxRecords?: number;
  /** A body too large for this bounded batch is left to its native reader. */
  oversized?(head: string): boolean;
}

/** Shared native byte cursor and record parser for transcript and usage readers.
 * Only complete newline-terminated records commit a cursor. Consumers select
 * record kinds before JSON parsing so metering never retains conversation text.
 */
export async function readRolloutIncrement<T>(options: RolloutReadOptions<T>): Promise<{
  cursor: number; identity: string; events: T[]; missing: boolean; more: boolean; bytes: number;
}> {
  const path = await canonicalRolloutPath(options.path, options.source?.nativeHome ?? options.nativeHome);
  const file = await open(path, "r");
  try {
    const stat = await file.stat(), identity = `${stat.dev}:${stat.ino}`;
    if (!Number.isSafeInteger(options.cursor) || options.cursor < 0 || options.cursor > stat.size
      || (options.identity !== null && options.identity !== identity)) throw new Error("Rollout source replaced");
    const capacity = 1024 * 1024;
    const buffer = Buffer.alloc(Math.min(capacity, stat.size - options.cursor));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, options.cursor);
    let cursor = options.cursor, start = 0, missing = false;
    const events: T[] = [];
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] !== 10) continue;
      const line = buffer.subarray(start, i).toString("utf8");
      start = i + 1; cursor = options.cursor + start;
      if (!options.select(line.slice(0, 65536))) continue;
      try {
        const event = options.retain(JSON.parse(line), cursor);
        if (event !== null) events.push(event);
      } catch { missing = true; }
      if (events.length >= (options.maxRecords ?? 128)) break;
    }
    if (start === 0 && bytesRead === capacity) {
      const end = await findNextNewline(file, options.cursor);
      if (end !== null) {
        missing = options.oversized?.(buffer.subarray(0, 65536).toString("utf8")) ?? true;
        cursor = end;
      }
    }
    await options.source?.validate();
    return { cursor, identity, events, missing, more: cursor < stat.size, bytes: bytesRead };
  } finally { await file.close(); }
}
