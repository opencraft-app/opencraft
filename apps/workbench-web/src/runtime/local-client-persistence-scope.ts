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
  private verified = true;
  private snapshot: ClientPersistenceScopeSnapshot = Object.freeze({ namespace: "local", threadMemoryScope: "local" });
  constructor(accounts: PlatformAccountContributionRegistry, localNamespace = "local", storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
    const rememberedKey = `${localNamespace}.last-local-partition.v1`;
    let remembered: string | null = null;
    let rememberedAccount: string | null = null;
    try {
      const raw = storage?.getItem(rememberedKey);
      const value: unknown = raw && raw.length <= 4096 ? JSON.parse(raw) : null;
      if (Array.isArray(value) && value.length === 3 && value[0] === localNamespace && typeof value[1] === "string" && typeof value[2] === "string") {
        remembered = JSON.stringify(value); rememberedAccount = value[1];
      }
    } catch { /* Display partition hints never block startup. */ }
    const initial = remembered ?? localNamespace;
    this.verified = remembered === null;
    this.snapshot = Object.freeze({ namespace: initial, threadMemoryScope: initial });
    let hasSeenAccount = false;
    const bind = () => {
      const binding = ++this.binding;
      this.stopAccount();
      const account = accounts.getSnapshot().contribution;
      if (account) hasSeenAccount = true;
      const refresh = () => {
        if (this.disposed || binding !== this.binding) return;
        const state = account?.getSnapshot();
        const wasVerified = this.verified;
        this.verified = account ? state?.phase === "authenticated" : !remembered;
        const verificationChanged = () => { if (wasVerified !== this.verified) for (const listener of this.listeners) listener(); };
        // Offline/initial discovery may retain local originals. This hint is
        // never supplied as identity or authorization to an account contribution.
        if (!account && !hasSeenAccount && remembered) { verificationChanged(); return; }
        if (account && (state?.phase === "loading" || state?.phase === "error")
          && !state.identity && rememberedAccount === account.id && remembered) { verificationChanged(); return; }
        const identity = state?.readStateScope !== undefined ? state.readStateScope : state?.identity?.id ?? null;
        const namespace = account ? JSON.stringify([localNamespace, account.id, identity]) : localNamespace;
        try {
          if (account && state?.phase === "authenticated" && typeof identity === "string") {
            remembered = namespace; rememberedAccount = account.id; storage?.setItem(rememberedKey, namespace);
          } else if (!account || state?.phase === "anonymous") {
            remembered = null; rememberedAccount = null; storage?.removeItem(rememberedKey);
          }
        } catch { /* Local hints do not change online authority. */ }
        if (namespace === this.snapshot.namespace) { verificationChanged(); return; }
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
  isVerified = () => this.verified && !this.disposed;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  dispose() { this.disposed = true; ++this.binding; this.stopAccount(); this.stopRegistry(); this.listeners.clear(); }
}
