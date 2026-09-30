import * as SecureStore from "expo-secure-store";

import { parseMobileLanguagePreference, type MobileLanguagePreference } from "./mobile-language";

const STORAGE_KEY = "opencraft.mobile-language-v1";
type Snapshot = Readonly<{ ready: boolean; preference: MobileLanguagePreference }>;
let snapshot: Snapshot = { ready: false, preference: "system" };
let initialization: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export const mobileLanguagePreference = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  initialize() {
    if (!initialization) {
      initialization = SecureStore.getItemAsync(STORAGE_KEY)
        .then(value => publish({ ready: true, preference: parseMobileLanguagePreference(value) }))
        .catch(() => publish({ ready: true, preference: "system" }));
    }
    return initialization;
  },
  async select(preference: MobileLanguagePreference) {
    await SecureStore.setItemAsync(STORAGE_KEY, preference);
    publish({ ready: true, preference });
  },
};
