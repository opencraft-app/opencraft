import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import type { HostConnectionProfile, HostConnectionProfileSnapshot, HostConnectionProfileStore } from "../host-connections";
import type { EnvironmentDirectory } from "./directory";

/** Compatibility adapter: discovered recipes are never written into saved profiles. */
export class EnvironmentProfileStore implements HostConnectionProfileStore {
  private readonly listeners = new Set<() => void>();
  private readonly stopConfigured: () => void;
  private readonly stopDirectory: () => void;
  private snapshot: HostConnectionProfileSnapshot = {revision: 0, profiles: []};
  constructor(private readonly configured: HostConnectionProfileStore, readonly directory: EnvironmentDirectory) {
    const updateConfigured = () => directory.setConfiguredProfiles(configured.getSnapshot().profiles);
    this.stopDirectory = directory.subscribe(() => this.publish());
    this.stopConfigured = configured.subscribe(updateConfigured);
    updateConfigured(); this.publish();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  recordMachineIdentity(hostId: string, identity: RuntimeMachineIdentity | null, agent: "OpenCraft" | "Codex" | null = null) { return this.configured.recordMachineIdentity?.(hostId, identity, agent) ?? Promise.resolve(); }
  put(profile: HostConnectionProfile) { return this.configured.put(profile); }
  remove(hostId: string) { return this.configured.remove(hostId); }
  close() { this.stopConfigured(); this.stopDirectory(); this.listeners.clear(); this.configured.close(); }
  private publish() {
    this.snapshot = Object.freeze({revision: this.snapshot.revision + 1, profiles: Object.freeze(this.directory.getSnapshot().entries.map(entry => entry.profile))});
    for (const listener of this.listeners) listener();
  }
}
