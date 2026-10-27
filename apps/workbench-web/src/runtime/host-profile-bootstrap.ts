import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import { normalizeHostConnectionProfile, type HostConnectionProfile, type HostConnectionProfileSnapshot, type HostConnectionProfileStore } from "@opencraft/workbench-runtime";
import { BrowserStorageError } from "./browser-storage-error";
import { IndexedDbHostConnectionProfileStore, type IndexedDbHostConnectionProfileStoreOptions } from "./indexeddb-host-profile-store";

/** Deployment recipes remain usable when browser-owned recipes cannot be read.
 * This projection never pretends to save edits or replaces the unread database.
 */
class DeploymentHostProfileStore implements HostConnectionProfileStore {
  private snapshot: HostConnectionProfileSnapshot;
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(profiles: readonly HostConnectionProfile[]) {
    if (new Set(profiles.map(profile => profile.hostId)).size !== profiles.length) {
      throw new Error("Duplicate deployment Host identity");
    }
    this.snapshot = Object.freeze({ revision: 0, profiles: Object.freeze(profiles.map(normalizeHostConnectionProfile)) });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  async put(_profile: HostConnectionProfile): Promise<void> { throw this.writeFailure(); }
  async remove(_hostId: string): Promise<boolean> { throw this.writeFailure(); }
  async recordMachineIdentity(hostId: string, identity: RuntimeMachineIdentity | null, agent: "OpenCraft" | "Codex" | null = null): Promise<void> {
    if (this.closed) return;
    this.snapshot = Object.freeze({ revision: this.snapshot.revision + 1,
      profiles: Object.freeze(this.snapshot.profiles.map(profile => profile.hostId === hostId
        ? normalizeHostConnectionProfile({ ...profile, machineIdentity: identity, agent }) : profile)) });
    for (const listener of [...this.listeners]) listener();
  }
  close(): void { this.closed = true; this.listeners.clear(); }
  private writeFailure() { return new Error("本地连接配置尚未恢复，暂时无法修改。请重新加载后重试；已保存的配置会保留。"); }
}

export async function openHostProfiles(options: IndexedDbHostConnectionProfileStoreOptions & {
  /** Only a hosted Web installation with an available server-owned catalog. */
  readonly allowDeploymentRecovery: boolean;
}): Promise<{ readonly store: HostConnectionProfileStore; readonly storageError: BrowserStorageError | null }> {
  try {
    return { store: await IndexedDbHostConnectionProfileStore.open(options), storageError: null };
  } catch (error) {
    // Configuration corruption and programming errors must remain visible.
    // Standalone clients cannot replace their only saved connection authority.
    if (!(error instanceof BrowserStorageError) || !options.allowDeploymentRecovery
      || !options.seed?.some(profile => profile.enabled)) throw error;
    return { store: new DeploymentHostProfileStore([...(options.seed ?? []), ...(options.ephemeral ?? [])]), storageError: error };
  }
}
