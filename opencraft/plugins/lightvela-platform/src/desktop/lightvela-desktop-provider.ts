import { desktopTargetKey, type DesktopAttachment, type DesktopBackend,
  type DesktopConnection, type DesktopTarget } from "@opencraft/plugin-cloud-desktop/contract";
import { createRfbDesktopAdapter, type DesktopRfbSession, type RfbDesktopAdapter } from "@opencraft/plugin-cloud-desktop/rfb";
import type { LightVelaAccountService, LightVelaRegion } from "../account/lightvela-account-service";

export interface LightVelaDesktopBinding {
  readonly target: DesktopTarget;
  readonly instanceId: string;
  readonly region: LightVelaRegion;
  /** Directory-authorized permission, not a user preference. */
  readonly viewingAllowed: boolean;
  /** Changes when permission, Server/instance binding or its authority changes. */
  readonly revision: string;
}

/** Supplied by the canonical Conversation + Server directory. Never use the
 * account's activeBotId or parse a legacy Host label to locate a desktop. */
export interface LightVelaDesktopDirectory {
  resolve(conversationId: string): LightVelaDesktopBinding | null;
  subscribe(listener: () => void): () => void;
}

export interface LightVelaPreparedDesktop {
  readonly resourceId: string;
  readonly preparationGenerationId: string;
}

export interface LightVelaDesktopViewerAttachment {
  readonly target: DesktopTarget;
  readonly instanceId: string;
  readonly resourceId: string;
  readonly preparationGenerationId: string;
  /** Verified physical desktop incarnation, not CTL preparation generation. */
  readonly incarnation: string;
  open(signal: AbortSignal): Promise<DesktopRfbSession>;
  release(): void;
}

/** Backend attachment broker integration boundary, not an invented HTTP API.
 * Must revalidate Conversation/Server/account/instance authority on the server,
 * issue bounded viewer access and enforce input grants. Not implemented by the
 * legacy desktop/session API or a browser-side raw TAT session. */
export interface LightVelaDesktopViewerPort {
  acquire(binding: LightVelaDesktopBinding, resource: LightVelaPreparedDesktop,
    signal: AbortSignal): Promise<LightVelaDesktopViewerAttachment>;
}

type AccountPort = Pick<LightVelaAccountService, "getSnapshot" | "subscribe" | "request">;

export interface LightVelaDesktopProviderOptions {
  readonly account: AccountPort;
  readonly directory: LightVelaDesktopDirectory;
  readonly viewer?: LightVelaDesktopViewerPort;
  readonly media?: RfbDesktopAdapter;
  readonly preparationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

function cleanup(action: (() => void) | undefined): void {
  try { action?.(); } catch { /* Retire all handles; no private diagnostics in UI. */ }
}

function parseResource(value: unknown, instanceId: string) {
  if (!value || typeof value !== "object") throw new Error("Desktop preparation response is invalid");
  const dto = value as Record<string, unknown>;
  if (dto.resource_id !== instanceId || typeof dto.generation_id !== "string" || !dto.generation_id
    || typeof dto.state !== "string" || !["preparing", "prepared", "failed", "paused", "unprepared"].includes(dto.state)) {
    throw new Error("Desktop preparation response is invalid");
  }
  return { resourceId: dto.resource_id as string, preparationGenerationId: dto.generation_id,
    state: dto.state as string };
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("Desktop preparation retired")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

interface Authority {
  readonly binding: LightVelaDesktopBinding;
  readonly key: string;
}

/** Vela owns product authority and preparation, not desktop rendering, Shell
 * placement, Chat transport or input coordinate conversion. */
export class LightVelaDesktopBackend implements DesktopBackend {
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<AbortController, Authority>();
  private readonly attachments = new Map<DesktopAttachment, Authority>();
  private readonly subscriptions: (() => void)[] = [];
  private readonly media: RfbDesktopAdapter;
  private closed = false;

  constructor(private readonly options: LightVelaDesktopProviderOptions) {
    const timeout = options.preparationTimeoutMs ?? 90_000;
    const poll = options.pollIntervalMs ?? 1500;
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(poll) || poll <= 0) {
      throw new Error("Invalid desktop preparation policy");
    }
    this.media = options.media ?? createRfbDesktopAdapter();
    try {
      this.subscriptions.push(options.account.subscribe(() => this.reconcile()));
      this.subscriptions.push(options.directory.subscribe(() => this.reconcile()));
    } catch (error) { this.dispose(); throw error; }
  }

  resolveTarget(conversationId: string): DesktopTarget | null {
    return this.resolveAuthority(conversationId)?.binding.target ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };

  private resolveAuthority(conversationId: string): Authority | null {
    if (this.closed || !this.options.viewer) return null;
    try {
      const binding = this.options.directory.resolve(conversationId);
      const account = this.options.account.getSnapshot();
      if (!binding || binding.viewingAllowed !== true || !binding.instanceId || !binding.revision
        || binding.target.conversationId !== conversationId || !binding.target.serverId
        || !binding.target.environmentId || !binding.target.principalId
        || binding.region !== account.region || account.session.status !== "authenticated"
        || account.details.profile?.id !== binding.target.principalId) return null;
      const immutable = Object.freeze({ ...binding, target: Object.freeze({ ...binding.target }) });
      return { binding: immutable, key: JSON.stringify([desktopTargetKey(immutable.target),
        immutable.instanceId, immutable.region, immutable.revision, account.authGeneration, account.session.epoch,
        account.credentialScope]) };
    } catch { return null; }
  }

  private current(authority: Authority): boolean {
    return this.resolveAuthority(authority.binding.target.conversationId)?.key === authority.key;
  }

  private reconcile(): void {
    if (this.closed) return;
    for (const [abort, authority] of [...this.operations]) if (!this.current(authority)) abort.abort();
    // A physical binding can change without changing the stable DesktopTarget.
    // Retire its attachment directly; target-key comparison alone is insufficient.
    for (const [attachment, authority] of [...this.attachments]) if (!this.current(authority)) attachment.release();
    for (const listener of this.listeners) cleanup(listener);
  }

  async prepare(target: DesktopTarget, signal: AbortSignal): Promise<DesktopAttachment> {
    const authority = this.resolveAuthority(target.conversationId);
    if (!authority || desktopTargetKey(authority.binding.target) !== desktopTargetKey(target)) {
      throw new Error("Desktop target is unavailable");
    }
    const abort = new AbortController();
    const prepareSignal = AbortSignal.any([signal, abort.signal,
      AbortSignal.timeout(this.options.preparationTimeoutMs ?? 90_000)]);
    this.operations.set(abort, authority);
    let viewer: LightVelaDesktopViewerAttachment | undefined;
    try {
      prepareSignal.throwIfAborted();
      const path = `/v1/instances/${encodeURIComponent(authority.binding.instanceId)}/desktop/resource`;
      // One explicit command. Never auto-retry an unknown POST result.
      let resource = parseResource(await this.options.account.request<unknown>(path,
        { method: "POST", signal: prepareSignal }), authority.binding.instanceId);
      const generation = resource.preparationGenerationId;
      while (true) {
        prepareSignal.throwIfAborted();
        if (!this.current(authority) || resource.preparationGenerationId !== generation) {
          throw new Error("Desktop preparation target changed");
        }
        if (resource.state === "prepared") break;
        if (resource.state !== "preparing") throw new Error("Desktop preparation is unavailable");
        await wait(this.options.pollIntervalMs ?? 1500, prepareSignal);
        resource = parseResource(await this.options.account.request<unknown>(path,
          { method: "GET", signal: prepareSignal }), authority.binding.instanceId);
      }
      const prepared = Object.freeze({ resourceId: resource.resourceId, preparationGenerationId: generation });
      viewer = await this.options.viewer!.acquire(authority.binding, prepared, prepareSignal);
      prepareSignal.throwIfAborted();
      if (!this.current(authority) || desktopTargetKey(viewer.target) !== desktopTargetKey(target)
        || viewer.instanceId !== authority.binding.instanceId || viewer.resourceId !== prepared.resourceId
        || viewer.preparationGenerationId !== generation || !viewer.incarnation) {
        throw new Error("Desktop attachment target changed");
      }
      const owned = viewer;
      const lifetime = new AbortController();
      let released = false, connecting = false;
      let connection: DesktopConnection | undefined;
      const attachment: DesktopAttachment = {
        target: authority.binding.target, resourceId: owned.resourceId, incarnation: owned.incarnation,
        connect: async connectSignal => {
          if (released || connecting || !this.current(authority)) throw new Error("Desktop attachment retired");
          connecting = true;
          const linked = AbortSignal.any([connectSignal, lifetime.signal]);
          let session: DesktopRfbSession | undefined;
          let handedToMedia = false;
          try {
            linked.throwIfAborted();
            session = await owned.open(linked);
            linked.throwIfAborted();
            if (!this.current(authority)) throw new Error("Desktop attachment target changed");
            handedToMedia = true;
            const connected = await this.media.connect(session, linked);
            if (linked.aborted || !this.current(authority)) {
              cleanup(() => connected.close()); throw new Error("Desktop connection retired");
            }
            connection = connected;
            return connected;
          } catch (error) {
            if (session && !handedToMedia) cleanup(() => session!.close());
            attachment.release();
            throw error;
          }
        },
        release: () => {
          if (released) return;
          released = true;
          this.attachments.delete(attachment);
          lifetime.abort();
          cleanup(() => connection?.close());
          cleanup(() => owned.release());
        },
      };
      this.attachments.set(attachment, authority);
      viewer = undefined; // Ownership transferred to the attachment.
      return attachment;
    } catch (error) {
      cleanup(() => viewer?.release());
      throw error;
    } finally { this.operations.delete(abort); }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const abort of this.operations.keys()) abort.abort();
    this.operations.clear();
    for (const attachment of [...this.attachments.keys()]) attachment.release();
    for (const unsubscribe of this.subscriptions.splice(0).reverse()) cleanup(unsubscribe);
    for (const listener of this.listeners) cleanup(listener);
    this.listeners.clear();
  }
}

/** Product composition only. Caller owns disposal of this provider, after its
 * panel consumers; disposing it never signs out or stops a Chat Host. */
export function createLightVelaCloudDesktopAdapter(options: LightVelaDesktopProviderOptions) {
  const media = options.media ?? createRfbDesktopAdapter();
  const backend = new LightVelaDesktopBackend({ ...options, media });
  return { backend, surfaces: media.surfaces, dispose: () => backend.dispose() };
}
