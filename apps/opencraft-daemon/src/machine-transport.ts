import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";

/** Identity-only leases never allocate an engine. Normal initialization remains native. */
export class MachineIdentityTransport implements DuplexTransport {
  private state: TransportStatus = { state: "idle" };
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private inner: DuplexTransport | null = null;
  private opening: Promise<DuplexTransport> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly machine: RuntimeMachineIdentity | null, private readonly agent: "OpenCraft" | "Codex",
    private readonly create: () => Promise<DuplexTransport> | DuplexTransport) {}

  get status() { return this.state; }
  async connect(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    if (this.closed || this.state.state === "failed") throw new Error("Transport is terminal");
    this.publish({ state: "open" });
  }

  async send(frame: string) {
    return this.sendWithContext(frame, { sender: null });
  }

  async sendWithContext(frame: string, context: TransportSubmissionContext) {
    const message = JSON.parse(frame) as Record<string, unknown>;
    // Releasing a failed/cold lease must never wait on a rejected engine startup.
    if (message.method === "runtime/client/disconnect") {
      const inner = await this.opening?.catch(() => null);
      if (inner?.status.state === "open") await inner.send(frame);
      return;
    }
    if (this.closed || this.state.state !== "open") throw new Error("Transport not open");
    if (message.method === "runtime/machine/read" && (typeof message.id === "string" || typeof message.id === "number")) {
      const response = JSON.stringify({ jsonrpc: "2.0", id: message.id,
        ...(this.machine === null ? { error: { code: -32601, message: "Remote machine identity is unavailable" } }
          : { result: { machine: this.machine, agent: this.agent } }),
        ...(message[LOGICAL_CLIENT_FIELD] ? { [LOGICAL_CLIENT_FIELD]: message[LOGICAL_CLIENT_FIELD] } : {}) });
      for (const listener of this.messages) listener(response);
      return;
    }
    this.opening ??= this.openInner();
    const inner = await this.opening;
    if (this.closed || this.state.state !== "open") throw new Error("Transport stopped during startup");
    if (inner.sendWithContext) await inner.sendWithContext(frame, context);
    else {
      if (context.sender !== null) throw new Error("Engine does not support verified sender attribution");
      await inner.send(frame);
    }
  }

  private async openInner(): Promise<DuplexTransport> {
    let stopStatus: (() => void) | undefined;
    try {
      const inner = await this.create();
      this.inner = inner;
      inner.subscribeMessage(value => { for (const listener of this.messages) listener(value); });
      stopStatus = inner.subscribeStatus(status => { if (status.state === "failed" || status.state === "closed") this.publish(status); });
      await inner.connect();
      if (this.closed) throw new Error("Transport closed during startup");
      return inner;
    } catch (error) {
      stopStatus?.();
      const inner = this.inner;
      this.inner = null;
      await inner?.close().catch(() => undefined);
      this.opening = null;
      if (!this.closed) this.publish({ state: "failed", reason: error instanceof Error ? error.message : "Engine startup failed" });
      throw error;
    }
  }

  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.opening?.catch(() => undefined);
      await this.inner?.close();
      this.inner = null;
      this.publish({ state: "closed" });
      this.messages.clear(); this.statuses.clear();
    })();
    return this.closing;
  }
  private publish(status: TransportStatus) { this.state = status; for (const listener of this.statuses) listener(status); }
}
