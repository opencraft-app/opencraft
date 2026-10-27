import type { ExtensionActivationIdentity } from "@opencraft/extension-contract";
import type { InternalContributionAdapter } from "./runtime";

export interface SingleContributionSnapshot<T> {
  readonly contribution: T | null;
}

/** A single optional contribution slot, owned by a committed registration. */
export class SingleContributionRegistry<T> {
  readonly #listeners = new Set<() => void>();
  #registration: { readonly owner: ExtensionActivationIdentity; readonly contribution: T } | null = null;
  #snapshot: SingleContributionSnapshot<T> = Object.freeze({ contribution: null });

  constructor(
    readonly label: string,
    readonly accepts: (value: unknown) => value is T,
  ) {}

  getSnapshot = (): SingleContributionSnapshot<T> => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  createAdapter() {
    return {
      prepare: (owner: ExtensionActivationIdentity, value: unknown) => {
        if (!this.accepts(value)) throw new TypeError(`Invalid ${this.label} contribution`);
        this.#assertAvailable();
        return {
          commit: () => {
            this.#assertAvailable();
            const registration = { owner, contribution: value };
            this.#registration = registration;
            this.#publish(value);
            return () => {
              // Contribution objects can be reused across activation generations.
              // Only this commit may retire this registration.
              if (this.#registration !== registration) return;
              this.#registration = null;
              this.#publish(null);
            };
          },
        };
      },
    } satisfies InternalContributionAdapter;
  }

  #assertAvailable(): void {
    if (this.#registration) throw new Error(`${this.label} already has an owner`);
  }

  #publish(contribution: T | null): void {
    this.#snapshot = Object.freeze({ contribution });
    for (const listener of this.#listeners) listener();
  }
}
