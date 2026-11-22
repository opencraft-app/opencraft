const groups = new WeakMap<object, Set<AuthorityChanges>>();
/** Owner-local post-mutation notifications, shared by repositories borrowing the
 * same database. Observers can withdraw admission; this is not a grant cache. */
export class AuthorityChanges {
  private readonly listeners = new Set<() => void>();
  private readonly group: Set<AuthorityChanges>;
  constructor(owner: object) {
    this.group = groups.get(owner) ?? new Set();
    groups.set(owner, this.group);
    this.group.add(this);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit() {
    const listeners = new Set([...this.group].flatMap((owner) => [...owner.listeners]));
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot undo a committed mutation. */
      }
    }
  }
  close() {
    this.emit();
    this.listeners.clear();
    this.group.delete(this);
  }
}
