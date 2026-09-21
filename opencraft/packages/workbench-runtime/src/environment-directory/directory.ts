import type { HostConnectionProfile } from "../host-connections";
import {
  environmentIdentity,
  type EnvironmentDirectorySnapshot,
  type EnvironmentEntry,
  type EnvironmentSource,
  type MachineResourceActionReceipt,
  type MachineResourceActionRequest,
} from "./contract";

/** Renderer-free catalog. No API calls, persistence, navigation or connections. */
export class EnvironmentDirectory {
  private readonly sources = new Map<string, { owner: string; source: EnvironmentSource; unsubscribe: () => void }>();
  private readonly ownedProviders = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private profiles: readonly HostConnectionProfile[] = [];
  private snapshot: EnvironmentDirectorySnapshot = Object.freeze({ revision: 0, entries: [], sources: [] });
  private signature = "";
  private closed = false;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setConfiguredProfiles(profiles: readonly HostConnectionProfile[]) { this.profiles = profiles; this.publish(); }

  register(owner: string, source: EnvironmentSource): () => void {
    if (this.closed) throw new Error("Environment directory is closed");
    if (!owner || !source.id || !source.label || !Array.isArray(source.providerIds)
      || typeof source.getSnapshot !== "function" || typeof source.subscribe !== "function"
      || typeof source.refresh !== "function" || typeof source.matchProfile !== "function"
      || (source.performResourceAction !== undefined
        && typeof source.performResourceAction !== "function")) throw new TypeError("Invalid environment source");
    if (this.sources.has(source.id)) throw new Error(`Duplicate environment source ${source.id}`);
    for (const record of this.sources.values()) {
      if (source.providerIds.some(id => record.source.providerIds.includes(id))) throw new Error("Environment provider already claimed");
    }
    const record = {owner, source, unsubscribe: () => {}};
    this.sources.set(source.id, record);
    source.providerIds.forEach(id => this.ownedProviders.add(id));
    record.unsubscribe = source.subscribe(() => this.publish());
    this.publish();
    return () => {
      if (this.sources.get(source.id) !== record) return;
      record.unsubscribe(); this.sources.delete(source.id); this.publish();
    };
  }
  async refresh(sourceId?: string) {
    const sources = [...this.sources.values()].filter(({source}) => !sourceId || source.id === sourceId);
    await Promise.all(sources.map(({source}) => source.refresh()));
  }
  async performResourceAction(
    request: MachineResourceActionRequest,
  ): Promise<MachineResourceActionReceipt> {
    if (!request.operationId.trim()) throw new TypeError("Machine resource operationId must not be empty");
    const entry = this.snapshot.entries.find((candidate) => candidate.id === request.environmentId);
    if (entry === undefined) throw new Error(`Unknown environment ${request.environmentId}`);
    if (entry.resource === null) throw new Error(`Environment ${request.environmentId} is not provider-managed`);
    if (entry.resource.capabilities[request.action] !== true) {
      throw new Error(`Environment ${request.environmentId} does not support ${request.action}`);
    }
    const record = this.sources.get(entry.sourceId);
    if (record === undefined
      || entry.resource.providerId !== record.source.id
      || record.source.performResourceAction === undefined) {
      throw new Error(`Environment ${request.environmentId} has no resource action owner`);
    }
    const receipt = await record.source.performResourceAction(request);
    if (receipt.accepted !== true
      || receipt.environmentId !== request.environmentId
      || receipt.action !== request.action
      || receipt.operationId !== request.operationId) {
      throw new Error("Machine resource provider returned an invalid receipt");
    }
    const current = this.snapshot.entries.find((candidate) => candidate.id === entry.id);
    if (this.closed
      || this.sources.get(entry.sourceId) !== record
      || current?.resource?.providerId !== entry.resource.providerId) {
      throw new Error("Machine resource action completed after its provider owner changed");
    }
    return receipt;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.sources.values()) record.unsubscribe();
    this.sources.clear(); this.profiles = []; this.publish(); this.listeners.clear();
  }
  private publish() {
    const entries: EnvironmentEntry[] = [];
    const hostIds = new Set<string>();
    const add = (entry: EnvironmentEntry) => {
      if (hostIds.has(entry.profile.hostId)) return;
      hostIds.add(entry.profile.hostId); entries.push(entry);
    };
    for (const profile of this.profiles) {
      if (this.ownedProviders.has(profile.providerId)) continue;
      add({id: environmentIdentity("configured", profile.hostId), sourceId: "configured", name: profile.displayName,
        location: profile.hostKind === "local" ? "此设备" : profile.executionLocation ?? "手动连接",
        resource: null, connectable: profile.enabled, profile});
    }
    const sources = [...this.sources.values()].map(({source}) => {
      const state = source.getSnapshot();
      const seen = new Set<string>();
      for (const entry of state.entries) {
        if (entry.sourceId !== source.id || seen.has(entry.id)) continue;
        seen.add(entry.id);
        const saved = this.profiles.find(profile => source.providerIds.includes(profile.providerId) && source.matchProfile(profile) === entry.id);
        // Preserve legacy Host/session identities and user visibility preferences,
        // but the source owns the authority-bound connection recipe.
        const profile = saved ? {...entry.profile, hostId: saved.hostId, enabled: saved.enabled && entry.connectable,
          includeInSidebar: saved.includeInSidebar} : entry.profile;
        add(Object.freeze({...entry, profile: Object.freeze(profile)}));
      }
      return {id: source.id, label: source.label, phase: state.phase, error: state.error};
    });
    entries.sort((a,b) => Number(b.profile.hostKind === "local") - Number(a.profile.hostKind === "local") || a.name.localeCompare(b.name));
    const signature = JSON.stringify({entries, sources});
    if (signature === this.signature) return;
    this.signature = signature;
    this.snapshot = Object.freeze({revision: this.snapshot.revision + 1, entries: Object.freeze(entries), sources: Object.freeze(sources)});
    for (const listener of this.listeners) listener();
  }
}
