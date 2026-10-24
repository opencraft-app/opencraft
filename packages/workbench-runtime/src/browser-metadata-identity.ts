/** Application-owned metadata keys; resource and account identities stay opaque. */
export const browserMetadataKeys = {
  pages: "opencraft.browser-pages.v1",
  tabs: "opencraft.browser-tabs.v1",
  bindings: "opencraft.conversation-bindings.v1",
  storage: "opencraft.browser-storage.v1",
  retiredStorage: "opencraft.browser-retired-storage.v1",
} as const;

const formerKeys: Readonly<Record<string, string>> = {
  [browserMetadataKeys.pages]: "vela.browser-pages.v1",
  [browserMetadataKeys.tabs]: "vela.browser-tabs.v1",
  [browserMetadataKeys.bindings]: "vela.conversation-bindings.v1",
};

/** Canonical values, including empty arrays, always supersede historical input. */
export function normalizeBrowserMetadata(values: Readonly<Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.values(browserMetadataKeys)) {
    const value = Object.hasOwn(values, key) ? values[key] : values[formerKeys[key] ?? key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function readBrowserMetadataValue(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): unknown },
  key: string,
  scope: (key: string) => string = key => key,
): string | null {
  const current = storage.getItem(scope(key));
  if (current !== null) return current;
  const former = formerKeys[key];
  const value = former === undefined ? null : storage.getItem(scope(former));
  if (value !== null) {
    try { storage.setItem(scope(key), value); }
    catch { /* Preserve readable historical input when optional persistence fails. */ }
  }
  return value;
}
