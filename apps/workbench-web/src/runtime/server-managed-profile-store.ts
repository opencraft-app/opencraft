import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import type { HostConnectionProfile, HostConnectionProfileSnapshot, HostConnectionProfileStore } from "@opencraft/workbench-runtime";

/** Read-only live overlay: the backend, not IDB, owns managed Server recipes. */
export class ServerManagedProfileStore implements HostConnectionProfileStore {
  private snapshot: HostConnectionProfileSnapshot = { revision: 0, profiles: [] };
  private readonly listeners = new Set<() => void>();
  private readonly stops: readonly (() => void)[];
  private closed = false;
  constructor(private readonly base: HostConnectionProfileStore, source: { subscribe(listener: () => void): () => void }, private readonly project: () => readonly HostConnectionProfile[]) {
    this.stops = [base.subscribe(() => this.publish()), source.subscribe(() => this.publish())];
    this.publish();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  put(profile: HostConnectionProfile) {
    if (profile.hostId.startsWith("ssh:")) return Promise.reject(new Error("请在远程连接设置中修改。"));
    return this.base.put(profile);
  }
  remove(hostId: string) {
    if (hostId.startsWith("ssh:")) return Promise.reject(new Error("请在远程连接设置中删除。"));
    return this.base.remove(hostId);
  }
  recordMachineIdentity(hostId: string, identity: RuntimeMachineIdentity | null, agent: "OpenCraft" | "Codex" | null = null) {
    // Managed SSH recipes do not supply physical-machine identity. Local Hosts
    // still delegate observations to their normal persistent metadata owner.
    if (hostId.startsWith("ssh:")) return Promise.resolve();
    return this.base.recordMachineIdentity?.(hostId, identity, agent) ?? Promise.resolve();
  }
  close() { if (this.closed) return; this.closed = true; for (const stop of this.stops) stop(); this.listeners.clear(); this.base.close(); }
  private publish() {
    if (this.closed) return;
    const base = this.base.getSnapshot().profiles;
    // Stored remote recipes would be a second authority: refuse, don't hide them.
    if (base.some(profile => profile.hostId.startsWith("ssh:"))) throw new Error("Remote connection conflicts with client-saved configuration");
    const profiles = [...base, ...this.project()];
    if (new Set(profiles.map(profile => profile.hostId)).size !== profiles.length) throw new Error("Duplicate remote Server identity");
    if (JSON.stringify(profiles) === JSON.stringify(this.snapshot.profiles)) return;
    this.snapshot = { revision: this.snapshot.revision + 1, profiles };
    for (const listener of this.listeners) listener();
  }
}
