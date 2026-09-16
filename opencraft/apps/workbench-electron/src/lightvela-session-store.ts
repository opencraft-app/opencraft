import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DesktopLoginSession } from "./lightvela-login.js";

import { createFilePrivateStorage, type PrivateStorage } from "./private-storage.js";

const SESSION_KEY = "lightvela-account";
function parseSession(value: unknown): DesktopLoginSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<DesktopLoginSession>;
  return (record.region === "cn" || record.region === "intl") && typeof record.token === "string" && record.token.trim()
    ? Object.freeze({ region: record.region, token: record.token }) : null;
}

/** Region/session semantics sit above application-owned storage, never Keychain. */
export function createDesktopSessionStore(directory: string, storage: PrivateStorage = createFilePrivateStorage(join(directory, "private-storage"))) {
  let generation = 0;
  let cached: DesktopLoginSession | null | undefined;
  return {
    async read(): Promise<DesktopLoginSession | null> {
      if (cached !== undefined) return cached;
      try {
        // Never decrypt legacy lightvela-account.encrypted: that invokes Keychain.
        const raw = storage.read(SESSION_KEY);
        if (!raw) return null;
        const envelope = JSON.parse(raw);
        cached = envelope.version === 1 ? parseSession(envelope.session) : null;
        return cached;
      } catch { return null; }
    },
    async save(session: DesktopLoginSession, signal?: AbortSignal): Promise<void> {
      const value = parseSession(session);
      if (!value) throw new Error("Invalid desktop session");
      const started = generation;
      // Preserve the async port and give a queued logout/cancel precedence.
      await Promise.resolve();
      signal?.throwIfAborted();
      if (started !== generation) throw new Error("Session storage operation was cancelled");
      try { storage.write(SESSION_KEY, JSON.stringify({ version: 1, session: value })); }
      catch { throw new Error("Could not save the local session. Check application data directory permissions."); }
      generation++;
      cached = value;
    },
    clear(): void {
      generation++; cached = null;
      storage.remove(SESSION_KEY);
      // Logout also removes obsolete local ciphertext without reading Keychain.
      rmSync(join(directory, "lightvela-account.encrypted"), { force: true });
      rmSync(join(directory, "lightvela-account.encrypted.tmp"), { force: true });
    },
  };
}
