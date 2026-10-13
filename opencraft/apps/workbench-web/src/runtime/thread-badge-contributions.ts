import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import type { ThreadBadgeContribution } from "@opencraft/extension-react";

/** One optional product badge owner; unloading releases both content and slot. */
export class ThreadBadgeContributionRegistry {
  readonly #listeners = new Set<() => void>();
  #snapshot: { readonly contribution: ThreadBadgeContribution | null } = { contribution: null };
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  createAdapter(): InternalContributionAdapter {
    return { prepare: (_owner, value) => {
      const contribution = value as ThreadBadgeContribution;
      if (!contribution?.id || typeof contribution.Component !== "function") throw new TypeError("Invalid thread badge contribution");
      if (this.#snapshot.contribution) throw new Error("Thread badge already has an owner");
      return { commit: () => {
        if (this.#snapshot.contribution) throw new Error("Thread badge already has an owner");
        this.#publish(contribution);
        return () => { if (this.#snapshot.contribution === contribution) this.#publish(null); };
      } };
    } };
  }
  #publish(contribution: ThreadBadgeContribution | null): void {
    this.#snapshot = { contribution };
    for (const listener of this.#listeners) listener();
  }
}
