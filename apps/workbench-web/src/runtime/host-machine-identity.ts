import { parseRuntimeMachineReadResponse, type RuntimeMachineReadResponse } from "@opencraft/appserver-protocol";
import type { HostConnectionProfile, HostConnectionProfileStore, HostRuntimeLifecycle, HostRuntimeRegistry } from "@opencraft/workbench-runtime";

/** One observation owner for probes, normal initialization and reconnects. */
export class HostMachineIdentityObserver<T extends HostRuntimeLifecycle> {
  private readonly generations = new Map<string, number>();
  private disposed = false;
  constructor(private readonly registry: HostRuntimeRegistry<T>, private readonly profiles: HostConnectionProfileStore,
    private readonly isCloud: (hostId: string) => boolean = () => false) {}

  async read(profile: HostConnectionProfile, request: () => Promise<unknown>): Promise<void> {
    const hostId = profile.hostId;
    if (this.disposed || this.isCloud(hostId)) return;
    const registration = this.registry.getRegistrationGeneration(hostId);
    const generation = (this.generations.get(hostId) ?? 0) + 1;
    this.generations.set(hostId, generation);
    let info: RuntimeMachineReadResponse | null;
    try { info = parseRuntimeMachineReadResponse(await request()); }
    catch (error) {
      // A transport failure or malformed response has no authority to erase a cache.
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== -32601) return;
      info = null;
    }
    const current = this.profiles.getSnapshot().profiles.find(profile => profile.hostId === hostId);
    if (this.disposed || this.generations.get(hostId) !== generation
      || registration === null || this.registry.getRegistrationGeneration(hostId) !== registration
      || !current || current.revision !== profile.revision || current.providerId !== profile.providerId
      || current.providerConfigVersion !== profile.providerConfigVersion || this.isCloud(hostId)) return;
    this.registry.recordMachineIdentity(hostId, info?.machine ?? null);
    await this.profiles.recordMachineIdentity?.(hostId, info?.machine ?? null, info?.agent ?? null);
  }

  dispose(): void { this.disposed = true; this.generations.clear(); }
}
