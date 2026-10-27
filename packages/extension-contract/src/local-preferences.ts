import type { ExtensionJson } from "./index.js";

/** Client-local presentation data only; never credentials or resource authorization. Last write wins. */
export interface ExtensionLocalPreferenceStore {
  get(key: string): ExtensionJson | null;
  set(key: string, value: ExtensionJson): void;
  subscribe(listener: () => void): () => void;
}
export interface ExtensionAccountPreferences {
  /** The plugin supplies its verified account key. The platform also isolates product and extension. */
  forAccount(accountKey: string): ExtensionLocalPreferenceStore;
}
