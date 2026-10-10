import { OPENCRAFT_DESKTOP_ATTACH, OPENCRAFT_DESKTOP_RELEASE, OPENCRAFT_DESKTOP_EXTENSION,
  parseHostDesktopCapability, parseHostDesktopCredential } from "@opencraft/appserver-protocol/desktop";
import { asConversationScopeId, type ConversationBindingStore, type HostRuntimeRegistry,
  type AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { desktopTargetKey, type DesktopAttachment, type DesktopBackend, type DesktopTarget } from "@opencraft/plugin-cloud-desktop/contract";
import { createRfbDesktopAdapter, type RfbDesktopAdapter } from "@opencraft/plugin-cloud-desktop/rfb";
import { createDesktopWireSession } from "@opencraft/plugin-cloud-desktop/session-wire";

const unavailable = () => new Error("Desktop is unavailable");
type Registry = Pick<HostRuntimeRegistry<AppServerWorkbenchRuntime>, "subscribe" | "getSnapshot" | "peekRuntime">;

/** Local Host adapter, independent of Vela/TAT. Client Scope aliases are only
 * presentation identities: requests use the bound native Thread ID, and the
 * Host constructs and checks its own authoritative binding before granting. */
export class HostDesktopBackend implements DesktopBackend {
  readonly recoverTransport = true;
  readonly surfaces;
  private readonly media: RfbDesktopAdapter;
  private readonly listeners = new Set<() => void>();
  private readonly watches = new Map<AppServerWorkbenchRuntime, () => void>();
  private readonly attachments = new Map<DesktopAttachment, () => boolean>();
  private readonly unsubscribers: (() => void)[] = [];
  private closed = false;
  constructor(private readonly options: {
    readonly bindings: ConversationBindingStore;
    readonly registry: Registry;
    readonly origin: string;
    readonly media?: RfbDesktopAdapter;
    readonly openSocket?: (url: string) => WebSocket;
  }) {
    this.media = options.media ?? createRfbDesktopAdapter();
    this.surfaces = this.media.surfaces;
    this.unsubscribers.push(options.bindings.subscribe(() => this.changed()));
    this.unsubscribers.push(options.registry.subscribe(() => this.watchRuntimes()));
    this.watchRuntimes();
  }

  private resolve(scope: string) {
    if (this.closed) return null;
    try {
      const origin = new URL(this.options.origin);
      if (origin.origin !== this.options.origin || !["http:", "https:"].includes(origin.protocol)) return null;
      const binding = this.options.bindings.resolve(asConversationScopeId(scope));
      if (!binding?.conversationKey) return null;
      const runtime = this.options.registry.peekRuntime(binding.hostId);
      if (!runtime || runtime.getSnapshot().phase !== "ready") return null;
      const capability = parseHostDesktopCapability(runtime.resources.host.getInitializeResult()?.capabilities?.extensions?.[OPENCRAFT_DESKTOP_EXTENSION]);
      if (!capability) return null;
      if (capability.transport === "same-origin-loopback" && (origin.protocol !== "http:"
        || !["127.0.0.1", "localhost"].includes(origin.hostname))) return null;
      const generation = runtime.resources.host.getConnectionGeneration?.();
      if (!generation) return null;
      const target: DesktopTarget = Object.freeze({ conversationId: scope, serverId: capability.serverId,
        environmentId: capability.environmentId, principalId: capability.principalId });
      const threadId = binding.conversationKey.threadId;
      return { runtime, threadId, target, renewable: capability.renewable === true,
        key: JSON.stringify([desktopTargetKey(target), threadId, generation, capability.renewable === true]) };
    } catch { return null; }
  }

  resolveTarget(scope: string): DesktopTarget | null { return this.resolve(scope)?.target ?? null; }
  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };

  private watchRuntimes(): void {
    if (this.closed) return;
    const live = new Set<AppServerWorkbenchRuntime>();
    for (const { hostId } of this.options.registry.getSnapshot().hosts) {
      const runtime = this.options.registry.peekRuntime(hostId);
      if (!runtime) continue;
      live.add(runtime);
      if (!this.watches.has(runtime)) this.watches.set(runtime, runtime.subscribe(() => this.changed()));
    }
    for (const [runtime, remove] of this.watches) if (!live.has(runtime)) { remove(); this.watches.delete(runtime); }
    this.changed();
  }

  private changed(): void {
    for (const [attachment, current] of [...this.attachments]) if (!current()) attachment.release();
    for (const listener of [...this.listeners]) listener();
  }

  async prepare(target: DesktopTarget, signal: AbortSignal): Promise<DesktopAttachment> {
    signal.throwIfAborted();
    const authority = this.resolve(target.conversationId);
    if (!authority || desktopTargetKey(target) !== desktopTargetKey(authority.target)) throw unavailable();
    const current = () => {
      const now = this.resolve(target.conversationId);
      return now?.key === authority.key && now.runtime === authority.runtime;
    };
    // Do not cancel the RPC read prematurely: capture/release a late grant
    // even if this View was retired while the Host was preparing it.
    const response: unknown = await authority.runtime.resources.protocol.request(OPENCRAFT_DESKTOP_ATTACH, { threadId: authority.threadId });
    const credential = parseHostDesktopCredential(response);
    const rawId = response && typeof response === "object" && "attachmentId" in response ? response.attachmentId : null;
    const releaseRemote = () => {
      // Never send an old release through a successor logical Client epoch.
      if (current() && typeof rawId === "string" && /^[A-Za-z0-9_-]{22}$/.test(rawId)) {
        void authority.runtime.resources.protocol.request(OPENCRAFT_DESKTOP_RELEASE, { attachmentId: rawId }).catch(() => {});
      }
    };
    try {
      signal.throwIfAborted();
      if (!current() || !credential || credential.target.conversationId !== authority.threadId
        || credential.target.serverId !== target.serverId || credential.target.environmentId !== target.environmentId
        || credential.target.principalId !== target.principalId || credential.instanceId !== target.environmentId
        || credential.resourceId !== target.environmentId || !/^[a-f0-9]{64}$/.test(credential.incarnation)
        || credential.expiresAt <= Date.now() || credential.expiresAt > Date.now() + 600_000) throw unavailable();
      const lifetime = new AbortController();
      let released = false, connected = false, ticket = credential.ticket;
      let timer = setTimeout(() => attachment.release(), credential.expiresAt - Date.now());
      const attachment: DesktopAttachment = {
        target: authority.target, resourceId: credential.resourceId, incarnation: credential.incarnation,
        connect: async openSignal => {
          if (released || connected || !current()) throw unavailable();
          connected = true;
          const linked = AbortSignal.any([openSignal, lifetime.signal]); linked.throwIfAborted();
          const endpoint = `${this.options.origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/desktop/connect`;
          const session = createDesktopWireSession({ attachmentId: credential.attachmentId, signal: linked,
            ...(authority.renewable ? { renewal: { expiresAt: credential.expiresAt, confirmed: (expiresAt: number) => {
              if (released || linked.aborted || !current()) { attachment.release(); return; }
              clearTimeout(timer); timer = setTimeout(() => attachment.release(), expiresAt - Date.now());
            } } } : {}),
            openSocket: () => {
              if (!current() || released) throw unavailable();
              return this.options.openSocket?.(endpoint) ?? new WebSocket(endpoint);
            },
            authenticate: send => {
              if (!current() || !ticket) throw unavailable();
              const scoped = ticket; ticket = "";
              send({ event: "desktop/attach", version: 1, attachmentId: credential.attachmentId, ticket: scoped });
            },
          });
          try { return await this.media.connect(session, linked); }
          catch { attachment.release(); throw unavailable(); }
        },
        release: () => {
          if (released) return;
          released = true; ticket = ""; clearTimeout(timer); lifetime.abort();
          this.attachments.delete(attachment); releaseRemote();
          signal.removeEventListener("abort", attachment.release);
        },
      };
      this.attachments.set(attachment, current);
      signal.addEventListener("abort", attachment.release, { once: true });
      if (signal.aborted) { attachment.release(); throw unavailable(); }
      return attachment;
    } catch { releaseRemote(); throw unavailable(); }
  }

  dispose(): void {
    if (this.closed) return;
    // Release against the still-current Client before shutting its provider.
    for (const attachment of [...this.attachments.keys()]) attachment.release();
    this.closed = true;
    for (const remove of this.unsubscribers.splice(0)) remove();
    for (const remove of this.watches.values()) remove();
    this.watches.clear(); this.listeners.clear();
  }
}
