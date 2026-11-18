import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadProfile } from "../adapters/local/profile.mjs";
import { MemoryFileStore } from "../adapters/memory/file-store.mjs";
import { MemoryFileTransaction } from "../adapters/memory/file-transaction.mjs";
import { botBinding, assertBotBinding } from "../domain/bot-binding.mjs";
import {
  MemoryBrowserError,
  validateMemoryBrowser,
  memoryBrowserFailure,
  createMemoryBrowserView,
  readMemoryBrowser,
} from "../application/memory-browser-view.mjs";

/** Trusted Host only. No runner, initialization, recovery, index rebuild or model call.
 * The original root lock protects a SELECT/file snapshot; it is not another business writer. */
export function readOfflineMemory(directory, binding, raw) {
  let lock;
  try {
    const p = validateMemoryBrowser(raw),
      grant = botBinding(binding);
    if (grant.owner.kind !== "human") throw new MemoryBrowserError("invalid");
    if (["set", "forget"].includes(p.action))
      throw new MemoryBrowserError("offline");
    const root = resolve(directory),
      profilePath = join(root, "bots", grant.botId);
    for (const at of [root, join(root, "bots"), profilePath]) {
      if (!existsSync(at)) throw new MemoryBrowserError("not_provisioned");
      const st = lstatSync(at);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw new MemoryBrowserError("storage");
    }
    if (!existsSync(join(profilePath, "profile.json")))
      throw new MemoryBrowserError("not_provisioned");
    const profile = loadProfile(profilePath);
    if (profile.config.layout !== "bot-v1")
      throw new MemoryBrowserError("storage");
    assertBotBinding(profile.config.botBinding, grant);
    if (!existsSync(join(profilePath, "memory")))
      throw new MemoryBrowserError("not_provisioned");
    const store = new MemoryFileStore(profile, { readOnly: true });
    if (
      store.json(store.ownerPath)?.owner !== profile.config.owner ||
      store.json(store.agentPath)?.id !== grant.botId ||
      store.json(store.agentPath)?.owner !== profile.config.owner
    )
      throw new MemoryBrowserError("storage");
    lock = new MemoryFileTransaction(store, {});
    lock.acquire();
    if (
      store.read(".transactions/pending.json", false, 64 * 1024 * 1024) !== null
    )
      throw new MemoryBrowserError("recovery_required");
    const snapshot = store.scan(),
      view = createMemoryBrowserView({
        ...snapshot,
        directory: "memory",
        writable: false,
      });
    return readMemoryBrowser(view, p, (ids) => {
      if (!ids.length) return [];
      const file = store.safe("assistant.sqlite");
      if (!existsSync(file))
        return ids.map((id) => ({ id, unavailable: true }));
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const identity = JSON.parse(
          db.prepare("SELECT value FROM meta WHERE key='identity'").get()
            ?.value ?? "null",
        );
        if (
          identity?.assistantId !== profile.config.assistantId ||
          identity?.owner !== profile.config.owner
        )
          throw new MemoryBrowserError("storage");
        const get = db.prepare(
          "SELECT m.id,m.text,m.at FROM conversation_message m JOIN conversation c ON c.id=m.conversation_id WHERE c.assistant_id=? AND m.id=? AND m.role='user'",
        );
        return ids.map((id) => {
          const m = get.get(grant.botId, id);
          return m
            ? {
                id: m.id,
                text: m.text.slice(0, 4000),
                at: m.at,
                truncated: m.text.length > 4000,
              }
            : { id, unavailable: true };
        });
      } finally {
        db.close();
      }
    });
  } catch (error) {
    return memoryBrowserFailure(error);
  } finally {
    lock?.release();
  }
}
