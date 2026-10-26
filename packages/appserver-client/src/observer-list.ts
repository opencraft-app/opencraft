/** Synchronous, non-authoritative Client observations. Each emission admits a
 * finite cut of registration instances. A same-function replacement belongs
 * to the next emission; an old unsubscribe handle cannot revoke it. */
export class ClientObserverList<T> {
  private readonly registrations = new Map<(value: T) => void, { readonly listener: (value: T) => void }>();

  subscribe(listener: (value: T) => void): () => void {
    const registration = this.registrations.get(listener) ?? { listener };
    this.registrations.set(listener, registration);
    return () => {
      if (this.registrations.get(listener) === registration) this.registrations.delete(listener);
    };
  }

  emit(value: T): void {
    for (const registration of [...this.registrations.values()]) {
      if (this.registrations.get(registration.listener) !== registration) continue;
      const listener = registration.listener;
      try { listener(value); }
      catch {
        // Diagnostics and lifecycle observers must never interrupt a peer,
        // native request admission, cancellation or completion.
      }
    }
  }

  clear(): void { this.registrations.clear(); }
}
