import type { HostConnectionProfileStore } from "@opencraft/workbench-runtime";

export const SERVER_CONNECTIONS_ID = "opencraft.server-connections";
export const SERVER_SSH_SETTINGS_ID = `${SERVER_CONNECTIONS_ID}.ssh`;
export const SERVER_CODEX_ACCOUNTS_SETTINGS_ID = `${SERVER_CONNECTIONS_ID}.codex-accounts`;

// Former built-in registration identity, accepted only when reading saved profiles.
const LEGACY_SERVER_PROVIDER_ID = "vela.headless-codex";

export async function migrateServerConnectionProfiles(store: HostConnectionProfileStore): Promise<void> {
  for (const profile of store.getSnapshot().profiles) {
    if (profile.providerId !== LEGACY_SERVER_PROVIDER_ID) continue;
    await store.put({ ...profile, providerId: SERVER_CONNECTIONS_ID, revision: profile.revision + 1 });
  }
}

/** Exact old bookmarks only; extension-owned IDs remain opaque. */
export function canonicalServerConnectionSettingsId(id: string): string {
  if (id === "vela.headless-codex.ssh") return SERVER_SSH_SETTINGS_ID;
  if (id === "vela.headless-codex.accounts") return SERVER_CODEX_ACCOUNTS_SETTINGS_ID;
  return id;
}

export function canonicalServerConnectionViewId(id: string): string {
  if (id === "vela.headless-codex.ssh-view") return `${SERVER_SSH_SETTINGS_ID}-view`;
  if (id === "vela.headless-codex.accounts-view") return `${SERVER_CODEX_ACCOUNTS_SETTINGS_ID}-view`;
  return id;
}
