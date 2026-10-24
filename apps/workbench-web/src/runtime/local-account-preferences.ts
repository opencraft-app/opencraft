import type { ExtensionLocalPreferenceStore } from "@opencraft/extension-contract";
import { serializeExtensionData } from "@opencraft/extension-runtime";

/** Browser adapter for generic extension/account-scoped presentation preferences. No remote writes. */
export class LocalAccountPreferences {
  readonly #stores = new Map<string, ExtensionLocalPreferenceStore>();
  constructor(readonly product: string, readonly storage: Pick<Storage, "getItem" | "setItem"> | (() => Storage),
    readonly events: Pick<Window, "addEventListener" | "removeEventListener">) {}
  #resolveStorage() { return typeof this.storage === "function" ? this.storage() : this.storage; }
  open = (extensionId: string, accountKey: string): ExtensionLocalPreferenceStore => {
    if (!extensionId || extensionId.length > 128 || !accountKey || accountKey.length > 256) throw new TypeError("Invalid preference owner");
    const prefix = `opencraft.account-preferences.v1:${JSON.stringify([this.product, extensionId, accountKey])}:`;
    const existing = this.#stores.get(prefix); if (existing) return existing;
    const listeners = new Set<() => void>();
    const keyFor = (key: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(key)) throw new TypeError("Invalid preference key");
      return prefix + key;
    };
    const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* A committed preference is independent of observers. */ } } };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(prefix)) return;
      try { if (event.storageArea === this.#resolveStorage()) notify(); } catch { /* A disabled store cannot provide a new snapshot. */ }
    };
    const store: ExtensionLocalPreferenceStore = {
      get: key => { const value = this.#resolveStorage().getItem(keyFor(key)); return value === null ? null : JSON.parse(value); },
      set: (key, value) => { this.#resolveStorage().setItem(keyFor(key), serializeExtensionData(value)); notify(); },
      subscribe: listener => {
        if (!listeners.size) this.events.addEventListener("storage", onStorage as EventListener);
        listeners.add(listener);
        let active = true;
        return () => { if (!active) return; active = false; listeners.delete(listener); if (!listeners.size) this.events.removeEventListener("storage", onStorage as EventListener); };
      },
    };
    this.#stores.set(prefix, store); return store;
  };
}
