import { createConversationKey, equalConversationKey, type ConversationKey } from "@opencraft/chat-core";

export interface SideChatRecord {
  readonly id: string;
  readonly parent: ConversationKey;
  readonly key: ConversationKey;
}
/** Old tombstones have no binding. Do not guess one from native fork lineage. */
export type SideChatDirectoryRow =
  | SideChatRecord
  | (SideChatRecord & { readonly closed: true })
  | { readonly id: string; readonly closed: true };

export function sideChatDirectoryBinding(row: SideChatDirectoryRow): SideChatRecord | null {
  return "parent" in row ? { id: row.id, parent: row.parent, key: row.key } : null;
}

/** Keep the deployed metadata leaf readable by strict v1 clients. Full closed
 * bindings travel in an additive, revision-bound Server projection instead. */
export function serializeSideChatDirectoryV1(rows: readonly SideChatDirectoryRow[]): string {
  return JSON.stringify(rows.map((row) => ("closed" in row ? { id: row.id, closed: true } : row)));
}

const identifier = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/u.test(value);

export function parseSideChatRecord(value: unknown): SideChatRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SideChatRecord>;
  if (
    Object.keys(row).some((key) => !["id", "parent", "key"].includes(key)) ||
    (row.parent && Object.keys(row.parent).some((key) => !["hostId", "threadId"].includes(key))) ||
    (row.key && Object.keys(row.key).some((key) => !["hostId", "threadId"].includes(key))) ||
    !identifier(row.id, 512) ||
    !identifier(row.parent?.hostId, 512) ||
    !identifier(row.parent?.threadId, 2048) ||
    !identifier(row.key?.hostId, 512) ||
    !identifier(row.key?.threadId, 2048) ||
    row.key.hostId !== row.parent.hostId ||
    row.key.threadId === row.parent.threadId
  )
    return null;
  return {
    id: row.id,
    parent: createConversationKey(row.parent.hostId, row.parent.threadId),
    key: createConversationKey(row.key.hostId, row.key.threadId),
  };
}

/** Closed IDs are durable tombstones, not another device's hidden-view state. */
export function parseSideChatDirectory(value: unknown): readonly SideChatDirectoryRow[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid side chat directory");
  const ids = new Set<string>();
  return value.map((row) => {
    if (!row || !identifier(row.id, 512) || ids.has(row.id)) throw new Error("Invalid side chat directory identity");
    ids.add(row.id);
    if (row.closed === true) {
      const { closed: _closed, ...binding } = row;
      if (Object.keys(binding).every((key) => key === "id")) return { id: row.id, closed: true };
      const record = parseSideChatRecord(binding);
      if (!record) throw new Error("Invalid closed side chat binding");
      return { ...record, closed: true };
    }
    const record = parseSideChatRecord(row);
    if (!record) throw new Error("Invalid side chat directory record");
    return record;
  });
}

/** A closed identity cannot be reopened or rebound by a stale client. Return the
 * canonical transition so legacy close writers cannot strip known ownership. */
export function validateSideChatDirectoryTransition(
  previous: readonly SideChatDirectoryRow[],
  next: readonly SideChatDirectoryRow[],
): readonly SideChatDirectoryRow[] {
  const rows = new Map(next.map((row) => [row.id, row]));
  for (const old of previous) {
    const row = rows.get(old.id);
    if ("closed" in old) {
      if (!row || !("closed" in row)) throw new Error("Closed side chat cannot be reopened");
    } else if (!row) throw new Error("Side chat close requires a tombstone");
    const oldBinding = sideChatDirectoryBinding(old);
    const binding = row && sideChatDirectoryBinding(row);
    if (
      binding &&
      (!oldBinding ||
        !equalConversationKey(binding.parent, oldBinding.parent) ||
        !equalConversationKey(binding.key, oldBinding.key))
    ) {
      throw new Error("Side chat identity is immutable");
    }
    if (row && "closed" in row && oldBinding) rows.set(old.id, { ...oldBinding, closed: true });
  }
  return next.map((row) => rows.get(row.id)!);
}
