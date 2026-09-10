import type { ExtensionActivationIdentity } from "@opencraft/extension-contract";
import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import type { PlatformAccountContribution } from "@opencraft/extension-react";

interface OwnedAccountContribution {
  readonly owner: ExtensionActivationIdentity;
  readonly contribution: PlatformAccountContribution;
}

export interface PlatformAccountContributionRegistrySnapshot {
  readonly revision: number;
  readonly contribution: PlatformAccountContribution | null;
}

export class PlatformAccountContributionRegistry {
  private owned: OwnedAccountContribution | null = null;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private snapshot: PlatformAccountContributionRegistrySnapshot = Object.freeze({
    revision: 0,
    contribution: null,
  });

  getSnapshot = (): PlatformAccountContributionRegistrySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  createAdapter(): InternalContributionAdapter {
    return {
      prepare: (owner, value) => {
        if (!isPlatformAccountContribution(value)) {
          throw new TypeError("Platform account contribution is invalid");
        }
        if (this.owned !== null) throw new Error("A platform account contribution is already registered");
        return {
          commit: () => {
            if (this.owned !== null) throw new Error("A platform account contribution is already registered");
            const owned = Object.freeze({ owner, contribution: value });
            this.owned = owned;
            this.publish();
            return () => {
              if (this.owned !== owned) return;
              this.owned = null;
              this.publish();
            };
          },
        };
      },
    };
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      revision: ++this.revision,
      contribution: this.owned?.contribution ?? null,
    });
    for (const listener of this.listeners) listener();
  }
}

function isPlatformAccountContribution(value: unknown): value is PlatformAccountContribution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PlatformAccountContribution>;
  return typeof candidate.id === "string"
    && candidate.id.trim().length > 0
    && typeof candidate.viewId === "string"
    && candidate.viewId.trim().length > 0
    && typeof candidate.getSnapshot === "function"
    && typeof candidate.subscribe === "function"
    && typeof candidate.refresh === "function"
    && typeof candidate.signOut === "function";
}
