import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { GenerationPeer, NativeGenerationError, rpcRecord } from "./generation-peer.js";

export interface NativeHistoryFailure {
  generationId: string; threadId: string;
  reads: { includeTurns: boolean; code: number; errorSha256: string }[];
}
export interface NativeHistoryFailures { version: 1; failures: NativeHistoryFailure[] }

/** Operator supplied evidence of failures also observed through the old reader. Never learned from a failing candidate. */
export function nativeHistoryFailures(value: unknown): NativeHistoryFailures {
  if (value === undefined) return { version: 1, failures: [] };
  const v = rpcRecord(value);
  if (v.version !== 1 || !Array.isArray(v.failures) || v.failures.length > 128) throw Error("Invalid historical failure manifest");
  const keys = new Set<string>();
  for (const raw of v.failures) {
    const row = rpcRecord(raw), key = JSON.stringify([row.generationId, row.threadId]);
    if (![row.generationId, row.threadId].every(s => typeof s === "string" && s.length > 0 && s.length <= 512)
      || keys.has(key) || !Array.isArray(row.reads) || row.reads.length !== 2) throw Error("Invalid historical failure entry");
    keys.add(key);
    for (const [index, rawRead] of row.reads.entries()) {
      const read = rpcRecord(rawRead);
      if (read.includeTurns !== Boolean(index) || !Number.isSafeInteger(read.code)
        || typeof read.errorSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(read.errorSha256)) throw Error("Invalid historical failure reads");
    }
  }
  return structuredClone(value) as NativeHistoryFailures;
}

export async function readNativeHistoryFailures(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 65536) {
    throw Error("Private historical failure manifest required");
  }
  return nativeHistoryFailures(JSON.parse(await readFile(path, "utf8")));
}

/** Read the same binding twice only for an explicitly retained failure; any difference fails closed. */
export async function readNativeHistory(peer: GenerationPeer, generationId: string, ids: readonly string[], expected: readonly NativeHistoryFailure[]) {
  if (expected.some(row => row.generationId !== generationId || !ids.includes(row.threadId))) throw Error("Historical failure binding changed");
  const loaded = rpcRecord(await peer.call("thread/loaded/list", {}));
  if (!Array.isArray(loaded.data) || !loaded.data.every(id => typeof id === "string")) throw Error("Native subscriptions unavailable");
  const failures: NativeHistoryFailure[] = [];
  for (const id of ids) {
    const retained = expected.find(row => row.threadId === id);
    if (retained && loaded.data.includes(id)) throw Error("Historical failure is now loaded");
    if (!retained) {
      const result = rpcRecord(await peer.call("thread/read", { threadId: id, includeTurns: false }));
      if (rpcRecord(result.thread).id !== id) throw Error("Native historical reader unavailable");
      continue;
    }
    for (const read of retained.reads) {
      let rejected = false;
      try { await peer.call("thread/read", { threadId: id, includeTurns: read.includeTurns }); }
      catch (error) {
        if (!(error instanceof NativeGenerationError) || !error.nativeRejection || error.rpcError.code !== read.code
          || createHash("sha256").update(JSON.stringify(error.rpcError)).digest("hex") !== read.errorSha256) throw Error("Historical failure changed");
        rejected = true;
      }
      if (!rejected) throw Error("Historical failure became readable");
    }
    failures.push(structuredClone(retained));
  }
  return { historicalCount: ids.length, failures };
}
