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
  private readonly owned = new Map<number, OwnedAccountContribution>();
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
        const priority = value.entrancePriority ?? 0;
        if (this.owned.has(priority)) throw new Error("A platform account contribution is already registered at this priority");
        return {
          commit: () => {
            if (this.owned.has(priority)) throw new Error("A platform account contribution is already registered at this priority");
            const owned = Object.freeze({ owner, contribution: value });
            this.owned.set(priority, owned);
            this.publish();
            return () => {
              if (this.owned.get(priority) !== owned) return;
              this.owned.delete(priority);
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
      contribution: [...this.owned.entries()].sort(([left], [right]) => right - left)[0]?.[1].contribution ?? null,
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
    && (candidate.signOut === undefined || typeof candidate.signOut === "function")
    && (candidate.entrancePriority === undefined || (typeof candidate.entrancePriority === "number" && Number.isSafeInteger(candidate.entrancePriority)));
}
