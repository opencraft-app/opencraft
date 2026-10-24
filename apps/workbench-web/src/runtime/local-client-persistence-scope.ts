import type { ClientPersistenceScope, ClientPersistenceScopeSnapshot } from "@opencraft/workbench-runtime";
import type { PlatformAccountContributionRegistry } from "./platform-account-contributions";

/** Local client cache partition. An account contribution supplies its own opaque
 * identity; this projection grants no remote authority and stores no credential.
 * Private products with credential-incarnation semantics provide their own port.
 */
export class LocalClientPersistenceScope implements ClientPersistenceScope {
  private readonly listeners = new Set<() => void>();
  private readonly stopRegistry: () => void;
  private stopAccount = () => {};
  private binding = 0;
  private disposed = false;
  private snapshot: ClientPersistenceScopeSnapshot = Object.freeze({ namespace: "local", threadMemoryScope: "local" });
  constructor(accounts: PlatformAccountContributionRegistry, localNamespace = "local") {
    this.snapshot = Object.freeze({ namespace: localNamespace, threadMemoryScope: localNamespace });
    const bind = () => {
      const binding = ++this.binding;
      this.stopAccount();
      const account = accounts.getSnapshot().contribution;
      const refresh = () => {
        if (this.disposed || binding !== this.binding) return;
        const state = account?.getSnapshot();
        const identity = state?.readStateScope !== undefined ? state.readStateScope : state?.identity?.id ?? null;
        const namespace = account ? JSON.stringify([localNamespace, account.id, identity]) : localNamespace;
        if (namespace === this.snapshot.namespace) return;
        this.snapshot = Object.freeze({ namespace, threadMemoryScope: namespace });
        for (const listener of this.listeners) listener();
      };
      this.stopAccount = account?.subscribe(refresh) ?? (() => {});
      refresh();
    };
    this.stopRegistry = accounts.subscribe(bind);
    bind();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  dispose() { this.disposed = true; ++this.binding; this.stopAccount(); this.stopRegistry(); this.listeners.clear(); }
}
