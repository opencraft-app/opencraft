import type { Thread } from "./generated/v2/Thread";

/** Discovery advertises an adapter, not proof of upstream pin support. */
export const OPENCRAFT_THREAD_PINS_EXTENSION = "opencraft/thread-pins";
export const OPENCRAFT_THREAD_PINS_CAPABILITY = Object.freeze({ version: 1 });

export interface ThreadPinsSnapshot {
  supported: boolean;
  /** Complete native pinned summaries, including rows outside recent pages. */
  data: Thread[];
}

export interface ThreadPinsMethodMap {
  "opencraft/thread-pins/list": { params: Record<string, never>; result: ThreadPinsSnapshot };
  "opencraft/thread-pins/set": { params: { threadId: string; pinned: boolean }; result: { pinned: boolean } };
}

export function supportsThreadPinDiscovery(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "version" in value && value.version === 1;
}

export function parseThreadPinsSnapshot(value: unknown): ThreadPinsSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("supported" in value) || typeof value.supported !== "boolean"
    || !("data" in value) || !Array.isArray(value.data)) throw new Error("Invalid native pin catalog");
  const seen = new Set<string>();
  for (const row of value.data) {
    if (typeof row !== "object" || row === null || typeof row.id !== "string" || !row.id
      || typeof row.cwd !== "string" || typeof row.updatedAt !== "number"
      || !Number.isFinite(row.updatedAt) || typeof row.preview !== "string" || !Array.isArray(row.turns)
      || seen.has(row.id)) throw new Error("Invalid native pinned thread summary");
    seen.add(row.id);
  }
  if (!value.supported && value.data.length !== 0) throw new Error("Unsupported native pin catalog contains rows");
  return value as ThreadPinsSnapshot;
}
