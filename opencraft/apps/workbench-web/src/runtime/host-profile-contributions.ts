import type { ExtensionActivationIdentity } from "@opencraft/extension-contract";
import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import {
  normalizeHostConnectionProfile,
  type HostConnectionProfile,
  type HostConnectionProfileContribution,
} from "@opencraft/workbench-runtime";

interface OwnedProfile {
  readonly owner: ExtensionActivationIdentity;
  readonly profile: HostConnectionProfile;
}

/**
 * Startup-only registry for activation-owned Host profiles. Profiles are
 * deliberately ephemeral: unloading an extension removes its Host on the
 * next application graph construction instead of resurrecting it from IDB.
 */
export class HostProfileContributionRegistry {
  private readonly profiles = new Map<string, OwnedProfile>();

  list(): readonly HostConnectionProfile[] {
    return Object.freeze([...this.profiles.values()].map(({ profile }) => profile));
  }

  createAdapter(): InternalContributionAdapter {
    return {
      prepare: (owner, value) => {
        if (typeof value !== "object" || value === null || !("profile" in value)) {
          throw new TypeError("Host profile contribution requires a profile");
        }
        const profile = normalizeHostConnectionProfile(
          (value as unknown as HostConnectionProfileContribution).profile,
        );
        if (this.profiles.has(profile.hostId)) {
          throw new Error(`Host profile ${profile.hostId} is already contributed`);
        }
        return {
          commit: () => {
            if (this.profiles.has(profile.hostId)) {
              throw new Error(`Host profile ${profile.hostId} is already contributed`);
            }
            const owned = Object.freeze({ owner, profile });
            this.profiles.set(profile.hostId, owned);
            let disposed = false;
            return () => {
              if (disposed) return;
              disposed = true;
              if (this.profiles.get(profile.hostId) === owned) this.profiles.delete(profile.hostId);
            };
          },
        };
      },
    };
  }
}
