import type { ConversationKey } from "@opencraft/chat-core";
import type { SideChatPersistence, SideChatRecord } from "@opencraft/workbench-runtime";
import { serverStorageKey } from "./server-context";
import { browserMetadataKeys } from "@opencraft/workbench-runtime/browser-metadata-identity";
import {
  parseSideChatDirectory,
  serializeSideChatDirectoryV1,
  sideChatDirectoryBinding,
  validateSideChatDirectoryTransition,
  type SideChatDirectoryRow,
} from "@opencraft/workbench-runtime/side-chat-records";
import {
  readCommittedMetadata,
  flushMetadataKey,
  observeCommittedMetadata,
  type ReadyAccountMetadataStorage,
} from "./account-metadata-storage";

/** Page recovery references, not a history cache or an authorization source.
 * Per-entity writes prevent one window from overwriting another's children. */
export function createSideChatPersistence(storage: Storage): SideChatPersistence {
  const prefix = serverStorageKey("opencraft.side-chat.v1:");
  const key = (id: string) => prefix + encodeURIComponent(id);
  function read(value: string | null): SideChatDirectoryRow | null {
    try {
      return parseSideChatDirectory([JSON.parse(value ?? "null")])[0] ?? null;
    } catch {
      return null;
    }
  }
  function directory(): readonly SideChatDirectoryRow[] {
    const rows: SideChatDirectoryRow[] = [];
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (!name?.startsWith(prefix)) continue;
      const row = read(storage.getItem(name));
      if (row && name === key(row.id)) rows.push(row);
    }
    return rows;
  }
  return {
    directory,
    list(parent: ConversationKey) {
      return directory().filter(
        (row): row is SideChatRecord =>
          !("closed" in row) && row.parent.hostId === parent.hostId && row.parent.threadId === parent.threadId,
      );
    },
    put(record) {
      const previous = read(storage.getItem(key(record.id)));
      const next = parseSideChatDirectory([record]);
      validateSideChatDirectoryTransition(previous ? [previous] : [], next);
      storage.setItem(key(record.id), JSON.stringify(record));
    },
    remove(id, binding) {
      const previous = read(storage.getItem(key(id)));
      const known = binding ? sideChatDirectoryBinding(binding) : previous && sideChatDirectoryBinding(previous);
      const next = parseSideChatDirectory([{ ...(known ?? { id }), closed: true }]);
      if (next[0]?.id !== id) throw new Error("Side chat identity is immutable");
      const retained = validateSideChatDirectoryTransition(previous ? [previous] : [], next);
      storage.setItem(key(id), JSON.stringify(retained[0]));
    },
  };
}

/** The authenticated Server owns this directory. This port only projects its
 * account-scoped rows and waits for acknowledgement before publishing writes. */
export function createSynchronizedSideChatPersistence(
  storage: ReadyAccountMetadataStorage,
  legacyStorage: Storage,
): SideChatPersistence {
  const key = serverStorageKey(browserMetadataKeys.sideChats);
  const legacy = createSideChatPersistence(legacyStorage);
  let cachedValue: string | undefined;
  let cachedRows: readonly SideChatDirectoryRow[] = [];
  const rows = () => {
    const value = storage.getCommittedSideChatDirectory?.() ?? readCommittedMetadata(storage, key) ?? "[]";
    if (value !== cachedValue) {
      cachedRows = parseSideChatDirectory(JSON.parse(value));
      cachedValue = value;
    }
    return cachedRows;
  };
  async function commit(update: (current: readonly SideChatDirectoryRow[]) => readonly SideChatDirectoryRow[]) {
    await storage.whenReady();
    const current = validateSideChatDirectoryTransition(
      rows(),
      parseSideChatDirectory(JSON.parse(storage.getItem(key) ?? "[]")),
    );
    const value = update(current);
    // Validate quota/format before replacing the readable projection.
    parseSideChatDirectory(value);
    if (storage.setSideChatDirectory) storage.setSideChatDirectory(JSON.stringify(value));
    else storage.setItem(key, serializeSideChatDirectoryV1(value));
    await flushMetadataKey(storage, key);
  }
  return {
    directory: rows,
    ready: () => storage.whenReady(),
    list(parent) {
      return rows().filter(
        (row): row is SideChatRecord =>
          !("closed" in row) && row.parent.hostId === parent.hostId && row.parent.threadId === parent.threadId,
      );
    },
    async put(record) {
      await commit((current) => {
        const previous = current.find((row) => row.id === record.id);
        if (previous && "closed" in previous) throw new Error("Side chat was closed on another device");
        return [...current.filter((row) => row.id !== record.id), record];
      });
      if (rows().some((row) => row.id === record.id && "closed" in row))
        throw new Error("Side chat was closed on another device");
    },
    async remove(id, binding) {
      await commit((current) => {
        const previous = current.find((row) => row.id === id);
        const known = binding ? sideChatDirectoryBinding(binding) : previous && sideChatDirectoryBinding(previous);
        if (known && known.id !== id) throw new Error("Side chat identity is immutable");
        return validateSideChatDirectoryTransition(current, [
          ...current.filter((row) => row.id !== id),
          { ...(known ?? { id }), closed: true },
        ]);
      });
    },
    subscribe(listener) {
      let active = true;
      const release = observeCommittedMetadata(storage, "sideChats", () => {
        if (active) listener();
      });
      void storage.whenReady().then(
        () => {
          if (active) listener();
        },
        () => {},
      );
      return () => {
        active = false;
        release?.();
      };
    },
    legacy(parent) {
      // A Server tombstone also suppresses an old, never-migrated device copy.
      const known = new Set(rows().map((row) => row.id));
      return legacy.list(parent).filter((record) => !known.has(record.id));
    },
    forgetLegacy(id) {
      try {
        legacy.remove(id);
      } catch {
        /* Already committed remotely; retry local cleanup later. */
      }
    },
  };
}
