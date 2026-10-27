export interface SelectionPreferenceStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Map only this owner's keys inside the same product/server partition. */
export function legacySelectionPreferenceKey(key: string, scope: (key: string) => string): string | null {
  for (const [current, former, suffix] of [
    ["opencraft.active-host-id", "vela.active-host-id", "none"],
    ["opencraft.active-thread-id", "vela.active-thread-id", "optional"],
    ["opencraft.selected-project-id", "vela.selected-project-id", "required"],
  ] as const) {
    const base = scope(current);
    if ((suffix !== "required" && key === base)
      || (suffix !== "none" && key.startsWith(`${base}:`) && key.length > base.length + 1)) {
      return scope(former) + key.slice(base.length);
    }
  }
  return null;
}

export function readSelectionPreference(storage: SelectionPreferenceStorage, key: string, scope: (key: string) => string): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const formerKey = legacySelectionPreferenceKey(key, scope);
  if (formerKey === null) return null;
  const former = storage.getItem(formerKey);
  if (former !== null && storage.setItem) {
    try {
      storage.setItem(key, former);
      storage.removeItem?.(formerKey);
    } catch { /* Optional preferences remain readable if copy-forward cannot persist. */ }
  }
  return former;
}

export function writeSelectionPreference(storage: Storage, key: string, value: string | null, scope: (key: string) => string): void {
  const formerKey = legacySelectionPreferenceKey(key, scope);
  if (value !== null) storage.setItem(key, value);
  // Remove the alias before clearing the current value so old input cannot
  // resurrect a deliberately forgotten conversation or project on reload.
  if (formerKey !== null) storage.removeItem(formerKey);
  if (value === null) storage.removeItem(key);
}
