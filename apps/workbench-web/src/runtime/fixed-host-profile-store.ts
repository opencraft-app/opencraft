import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import { normalizeHostConnectionProfile, type HostConnectionProfile, type HostConnectionProfileSnapshot, type HostConnectionProfileStore } from "@opencraft/workbench-runtime";

/** Application-owned adapter for a product's fixed, ephemeral execution target.
 * Never opens the standalone catalog. Observations live only for this Application.
 */
export class FixedHostProfileStore implements HostConnectionProfileStore {
  private snapshot: HostConnectionProfileSnapshot;
  private readonly listeners = new Set<() => void>();
  private closed = false;
  constructor(profiles: readonly HostConnectionProfile[]) {
    if (profiles.length !== 1) throw new Error("A fixed presentation requires one explicit Host");
    this.snapshot = Object.freeze({ revision: 0, profiles: Object.freeze(profiles.map(normalizeHostConnectionProfile)) });
  }
  getSnapshot = (): HostConnectionProfileSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  async put(_profile: HostConnectionProfile): Promise<void> { throw new Error("The embedding product owns Host configuration"); }
  async remove(_hostId: string): Promise<boolean> { throw new Error("The embedding product owns Host configuration"); }
  async recordMachineIdentity(hostId: string, identity: RuntimeMachineIdentity | null, agent: "OpenCraft" | "Codex" | null = null): Promise<void> {
    if (this.closed) return;
    this.snapshot = Object.freeze({ revision: this.snapshot.revision + 1, profiles: Object.freeze(this.snapshot.profiles.map(profile => profile.hostId === hostId
      ? normalizeHostConnectionProfile({ ...profile, machineIdentity: identity, agent }) : profile)) });
    for (const listener of this.listeners) listener();
  }
  close(): void { this.closed = true; this.listeners.clear(); }
}
