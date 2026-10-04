import type { BotTerminalSession } from "../domain/types";
import { TencentTatSessionMultiplexer, type TsshProxyClientOptions } from "../lib/tencent-tat-session-multiplexer";

export interface HermesPhysicalConnectionBinding {
  readonly accountId: string;
  readonly instanceId: string;
  readonly region: "cn" | "intl";
  readonly apiBase?: string;
}

export interface HermesPhysicalConnectionPreparationOptions extends HermesPhysicalConnectionBinding {
  readonly assertAuthority: () => void;
  readonly createSession: (signal: AbortSignal) => Promise<BotTerminalSession>;
  readonly WebSocketImpl?: typeof WebSocket;
  /** Bounds both preparation and the unclaimed resource lifetime. */
  readonly timeoutMs?: number;
}

export interface PreparedHermesPhysicalConnection {
  readonly bootstrap: BotTerminalSession;
  readonly proxy: TencentTatSessionMultiplexer;
}

/** One-shot transfer capability, never a Host, Profile or credential cache. */
export class HermesPhysicalConnectionPreparation {
  private state: "available" | "claiming" | "claimed" | "disposed" = "available";
  private readonly abort = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private proxy: TencentTatSessionMultiplexer | null = null;
  private readonly ready: Promise<PreparedHermesPhysicalConnection | null>;

  constructor(private readonly options: HermesPhysicalConnectionPreparationOptions) {
    this.options = { ...options };
    if (!options.accountId.trim() || !/^[a-zA-Z0-9_-]+$/u.test(options.instanceId)
      || (options.region !== "cn" && options.region !== "intl")) {
      throw new TypeError("Invalid physical connection preparation binding");
    }
    this.timer = globalThis.setTimeout(() => this.dispose(), options.timeoutMs ?? 15_000);
    (this.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    const cancelled = new Promise<null>(resolve => {
      this.abort.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    this.ready = Promise.race([this.prepare(), cancelled]).catch(() => {
      this.dispose();
      return null;
    });
  }

  matches(binding: HermesPhysicalConnectionBinding): boolean {
    return this.options.accountId === binding.accountId
      && this.options.instanceId === binding.instanceId
      && this.options.region === binding.region
      && (this.options.apiBase ?? "").replace(/\/$/u, "") === (binding.apiBase ?? "").replace(/\/$/u, "");
  }

  private assertCurrent(): void {
    this.abort.signal.throwIfAborted();
    this.options.assertAuthority();
  }

  private async prepare(): Promise<PreparedHermesPhysicalConnection> {
    this.assertCurrent();
    const bootstrap = await this.options.createSession(this.abort.signal);
    this.assertCurrent();
    if (!bootstrap || typeof bootstrap.wsUrl !== "string" || !/^wss?:\/\//u.test(bootstrap.wsUrl)
      || typeof bootstrap.sessionId !== "string" || !bootstrap.sessionId) {
      throw new TypeError("Invalid TAT session bootstrap");
    }
    const proxy = new TencentTatSessionMultiplexer(bootstrap, {
      WebSocketImpl: this.options.WebSocketImpl,
      // No PTY, loopback probe, Dashboard bootstrap or RPC before adoption.
      onClose: () => { if (this.state !== "claimed") this.dispose(); },
      onError: () => { if (this.state !== "claimed") this.dispose(); },
      diagnosticContext: { hostId: "lightvela-embedded-preparation", generation: 0 },
    });
    this.proxy = proxy;
    await proxy.connect();
    this.assertCurrent();
    return { bootstrap, proxy };
  }

  async claim(binding: HermesPhysicalConnectionBinding, signal: AbortSignal | undefined,
    health: Pick<TsshProxyClientOptions, "idleKeepaliveIntervalMs" | "idleKeepaliveTarget" | "onUnhealthy">,
  ): Promise<PreparedHermesPhysicalConnection | null> {
    if (!this.matches(binding) || this.state !== "available" || signal?.aborted) return null;
    this.state = "claiming";
    const cancel = () => this.dispose();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const resource = await this.ready;
      if (resource === null) return null;
      this.assertCurrent();
      signal?.throwIfAborted();
      resource.proxy.configureIdleKeepalive(health);
      this.state = "claimed";
      globalThis.clearTimeout(this.timer);
      this.proxy = null;
      return resource;
    } catch {
      this.dispose();
      return null;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  /** Once transferred, only the formal transport can close the connection. */
  dispose(): void {
    if (this.state === "claimed" || this.state === "disposed") return;
    this.state = "disposed";
    globalThis.clearTimeout(this.timer);
    this.abort.abort();
    this.proxy?.close();
    this.proxy = null;
  }
}
