import type { HostConnectionProfileStore, HostConnectionProfile } from "../host-connections";
import type { HostRuntimeLifecycle, HostRuntimeRegistration, HostRuntimeRegistry } from "../host-runtime-registry";

/** Discover factories without touching runtime/session lifetimes or selection. */
export function connectEnvironmentRuntimeRegistry<T extends HostRuntimeLifecycle>(
  profiles: HostConnectionProfileStore,
  registry: HostRuntimeRegistry<T>,
  create: (profile: HostConnectionProfile) => HostRuntimeRegistration<T>,
): () => void {
  const sync = () => {
    for (const profile of profiles.getSnapshot().profiles) {
      if (profile.enabled && !registry.has(profile.hostId)) registry.register(create(profile));
    }
  };
  const unsubscribe = profiles.subscribe(sync);
  sync();
  return unsubscribe;
}
